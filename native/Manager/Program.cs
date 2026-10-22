using HomeMCP.Processes;
using System;
using System.IO;
using System.IO.Pipes;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using System.Threading;
using System.Net.Http;
using System.Net.Sockets;
using System.Net;
using System.Net.Http.Headers;

namespace HomeMCP.Manager;

static class Program {
 [STAThread] static void Main() {
  using var single=new Mutex(true, @"Local\HomeMCP-Manager-SingleInstance", out bool owner);
  if(!owner)return;
  ApplicationConfiguration.Initialize();
  Application.Run(new TrayContext());
 }
}
sealed class TrayContext : ApplicationContext {
 readonly string app=Directory.GetParent(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar))!.FullName;
 readonly string dir=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"HomeMCP");
 readonly NotifyIcon tray;
 Process? host;
 Process? oracleGateway;
 bool oracleTunnelStarted=false;
 readonly IProcessSupervisor supervisor=new WindowsJobProcessSupervisor();
 CancellationTokenSource cancel=new();
 Form? settings;
 Label? statusLabel;
 Label? componentsLabel;
 readonly System.Windows.Forms.Timer monitor=new(){Interval=300000};
 readonly HttpClient http=new(){Timeout=TimeSpan.FromSeconds(2)};
 string LastHealth="Not checked";
 int hostFailures=0, bridgeFailures=0;
 bool monitoring=false;
 DateTimeOffset lastRecovery=DateTimeOffset.MinValue;
 bool SetupDone=>File.Exists(Path.Combine(dir,"setup-complete.marker"));
 TextBox? hostnameBox;
 Label? cloudflareStatus;
 string StatePath => Path.Combine(dir,"network-setup.json");
 string ConfigPath => Path.Combine(dir,"config.json");
 public TrayContext(){
  Directory.CreateDirectory(dir);
  _=formDispatcher.Handle; // marshal pipe callbacks to the UI thread even with no window open
  tray=new NotifyIcon {Icon=SystemIcons.Application,Text="HomeMCP",Visible=true};
  var menu=new ContextMenuStrip();
  menu.Items.Add("Settings",null,(_,_)=>OpenSettings());
  menu.Items.Add("Start",null,(_,_)=>Start());
  menu.Items.Add("Stop",null,(_,_)=>Stop());
  menu.Items.Add("Restart",null,(_,_)=>{Stop();Start();});
  menu.Items.Add("Exit manager",null,(_,_)=>{Stop();cancel.Cancel();supervisor.Dispose();tray.Visible=false;ExitThread();});
  tray.ContextMenuStrip=menu;
  tray.DoubleClick+=(_,_)=>OpenSettings();
  if(Environment.GetEnvironmentVariable("HOMEMCP_UI_SMOKE")=="1"){
   // Real WinForms startup/layout check in an isolated CI runner: no Host, relay,
   // credentials or monitoring are started.
   OpenSettings();
   var probe=new System.Windows.Forms.Timer{Interval=500};
   probe.Tick+=(_,_)=>{
    probe.Stop();
    try{
     if(settings is null||!settings.Visible||settings.Controls.Count==0)throw new Exception("manager_ui_not_visible");
     var controls=new System.Collections.Generic.List<Control>();
     void Collect(Control root){controls.Add(root);foreach(Control child in root.Controls)Collect(child);}
     Collect(settings);
     if(!controls.OfType<Button>().Any())throw new Exception("manager_ui_buttons_missing");
     var marker=Environment.GetEnvironmentVariable("HOMEMCP_UI_SMOKE_MARKER");
     if(!String.IsNullOrEmpty(marker))File.WriteAllText(marker,"HOMEMCP_UI_READY");
    }catch(Exception e){Environment.ExitCode=1;Console.Error.WriteLine(e);}
    finally{tray.Visible=false;settings?.Close();ExitThread();}
   };
   probe.Start();
   return;
  }
  _=Task.Run(()=>PipeLoop(cancel.Token));
  monitor.Tick+=async (_,_)=>await MonitorCycle();
  monitor.Start();
  if(SetupDone){Start();}else{OpenSettings();}
  _=MonitorCycle();
 }
 bool Running=>host is {HasExited:false};
 string Status=>Running?$"Host process running (PID {host!.Id}); health: {LastHealth}":"Host stopped";
 void RefreshStatus(){if(statusLabel is {IsDisposed:false})statusLabel.Text=Status;tray.Text=Running?"HomeMCP host process running":"HomeMCP stopped";}
 string ComponentReport(){
  var lines=new System.Collections.Generic.List<string>();
  lines.Add("Node runtime: "+(File.Exists(Path.Combine(app,"runtime","node.exe"))?"Installed":"MISSING"));
  lines.Add("Process supervision: Windows Job Object");
  lines.Add("PowerShell: "+(File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell","v1.0","powershell.exe"))?"Available":"MISSING"));
  lines.Add("Playwright worker: "+(File.Exists(Path.Combine(app,"workers","playwright","cli.mjs"))?"Installed":"MISSING"));
  lines.Add("Desktop worker: "+(File.Exists(Path.Combine(app,"workers","windows-mcp.exe"))?"Installed":"MISSING"));
  lines.Add("Host configuration: "+(File.Exists(ConfigPath)?"Created":"Not created (generated on start)"));
  lines.Add("Network: "+(ReadState()["remoteEnabled"]?.GetValue<bool>()==true?"Remote requested":"Local only (safe default)"));
  lines.Add("Oracle tunnel: "+(oracleTunnelStarted?FrpTunnel.Status():"Not configured / stopped"));
  lines.Add("Host health: "+LastHealth);
  return string.Join(Environment.NewLine,lines);
 }
 bool RequirementsOK()=>File.Exists(Path.Combine(app,"runtime","node.exe"))
  &&File.Exists(Path.Combine(app,"workers","playwright","cli.mjs"))
  &&File.Exists(Path.Combine(app,"workers","windows-mcp.exe"))
  &&File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell","v1.0","powershell.exe"));
 async Task ProbeHealth(){
  string result="Unavailable";
  try{
   if(File.Exists(ConfigPath)){
    var config=JsonNode.Parse(await File.ReadAllTextAsync(ConfigPath)) as JsonObject;
    var port=config?["port"]?.GetValue<int>()??0;
    if(port>0){
     using var response=await http.GetAsync("http://127.0.0.1:"+port+"/health");
     if(response.IsSuccessStatusCode){
      var body=JsonNode.Parse(await response.Content.ReadAsStringAsync()) as JsonObject;
      result=body?["ok"]?.GetValue<bool>()==true?"Healthy":"Unhealthy";
      var workers=body?["workers"] as JsonObject;
      if(workers!=null){
       result+="; browser "+(workers["browser"]?["status"]?.ToString()??"unknown")
          +"; desktop "+(workers["desktop"]?["status"]?.ToString()??"unknown");
      }
     }else result="HTTP "+(int)response.StatusCode;
    }
   }
  }catch(Exception ex){result="Unavailable ("+ex.GetType().Name+")";}
  LastHealth=result;
  if(statusLabel is {IsDisposed:false}) RefreshStatus();
  if(componentsLabel is {IsDisposed:false})componentsLabel.Text=ComponentReport();
 }
 async Task MonitorCycle(){
  if(monitoring)return;
  monitoring=true;
  try{
   await ProbeHealth();
   bool hostHealthy=LastHealth.StartsWith("Healthy",StringComparison.Ordinal);
   hostFailures=hostHealthy?0:hostFailures+1;
   bool bridgeHealthy=await CheckBridge(false);
   bridgeFailures=bridgeHealthy?0:bridgeFailures+1;
   if(DateTimeOffset.UtcNow-lastRecovery<TimeSpan.FromMinutes(15))return;
   if(hostFailures>=2 && SetupDone){
    lastRecovery=DateTimeOffset.UtcNow;
    LogRecovery("host_restart");
    Stop();Start();
    hostFailures=0;
    return;
   }
   if(bridgeFailures>=2){
    lastRecovery=DateTimeOffset.UtcNow;
    LogRecovery("bridge_repair");
    if(await CheckBridge(true))bridgeFailures=0;
    else LogRecovery("bridge_repair_failed");
   }
  }catch(Exception ex){LogRecovery("monitor_error:"+ex.GetType().Name);}
  finally{monitoring=false;}
 }
 void LogRecovery(string message){
  try{File.AppendAllText(Path.Combine(dir,"manager-recovery.log"),DateTimeOffset.UtcNow.ToString("O")+" "+message+Environment.NewLine);}catch{}
 }
 async Task<bool> CheckBridge(bool repair){
  // The bridge is independent from host egress. Only check installations where
  // the user has already configured the HomeMCP-specific protected bridge.
  var bridge=Path.Combine(dir,"start-cloudflare-bridge.ps1");
  var proxy=Path.Combine(dir,"protected-proxy.mjs");
  var credential=Path.Combine(dir,"cloudflared","credentials.json");
  if(!File.Exists(bridge)||!File.Exists(proxy)||!File.Exists(credential))return true;
  var helper=Path.Combine(app,"scripts","bridge-watch.ps1");
  if(!File.Exists(helper))return false;
  var ps=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell","v1.0","powershell.exe");
  using var process=Process.Start(new ProcessStartInfo(ps){
   UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,
   Arguments="-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \""+helper+"\""+(repair?" -Repair":"")
  });
  if(process==null)return false;
  using var timeout=new CancellationTokenSource(TimeSpan.FromSeconds(30));
  try{await process.WaitForExitAsync(timeout.Token);}
  catch(OperationCanceledException){try{process.Kill(entireProcessTree:true);}catch{};LogRecovery("bridge_check_timeout");return false;}
  return process.ExitCode==0;
 }
 async Task VerifyByotConnection(){
  var state=ReadState();
  if(state["mode"]?.GetValue<string>()!="external")return;
  var url=state["url"]?.GetValue<string>()??throw new Exception("Configure the BYOT HTTPS domain first");
  var uri=new Uri(url);
  if(uri.Scheme!="https"||uri.Port!=443||uri.AbsolutePath!="/"||uri.UserInfo.Length>0||uri.Query.Length>0||uri.Fragment.Length>0)throw new Exception("BYOT requires a bare HTTPS origin");
  var addresses=await Dns.GetHostAddressesAsync(uri.DnsSafeHost);
  if(addresses.Length==0||addresses.Any(ip=>!IsPublicAddress(ip)))throw new Exception("BYOT DNS must resolve only to public IP addresses");
  var config=JsonNode.Parse(await File.ReadAllTextAsync(ConfigPath));
  var port=config?["port"]?.GetValue<int>()??0;
  var admin=config?["security"]?["adminToken"]?.GetValue<string>();
  if(port<1||String.IsNullOrEmpty(admin))throw new Exception("Local HomeMCP is not configured");
  using var local=new HttpRequestMessage(HttpMethod.Post,"http://127.0.0.1:"+port+"/admin/tunnel-check");
  local.Headers.Authorization=new AuthenticationHeaderValue("Bearer",admin);
  using var localResponse=await http.SendAsync(local);
  localResponse.EnsureSuccessStatusCode();
  var challenge=JsonNode.Parse(await localResponse.Content.ReadAsStringAsync());
  var path=challenge?["path"]?.GetValue<string>()??throw new Exception("Missing verification path");
  var expected=challenge?["nonce"]?.GetValue<string>()??throw new Exception("Missing verification nonce");
  using var handler=new HttpClientHandler{AllowAutoRedirect=false,UseProxy=false};
  using var remote=new HttpClient(handler){Timeout=TimeSpan.FromSeconds(10)};
  using var response=await remote.GetAsync(url.TrimEnd('/')+path);
  if(!response.IsSuccessStatusCode)throw new Exception("Tunnel cannot reach this HomeMCP (HTTP "+(int)response.StatusCode+")");
  var result=JsonNode.Parse(await response.Content.ReadAsStringAsync());
  if(result?["nonce"]?.GetValue<string>()!=expected)throw new Exception("Tunnel points to a different HomeMCP instance");
  using var metadata=await remote.GetAsync(url.TrimEnd('/')+"/.well-known/oauth-authorization-server");
  if(!metadata.IsSuccessStatusCode)throw new Exception("OAuth discovery unavailable through the tunnel");
  var oauth=JsonNode.Parse(await metadata.Content.ReadAsStringAsync());
  if(oauth?["issuer"]?.GetValue<string>()!=url.TrimEnd('/'))throw new Exception("OAuth issuer does not match BYOT domain");
  using var resourceResponse=await remote.GetAsync(url.TrimEnd('/')+"/.well-known/oauth-protected-resource");
  if(!resourceResponse.IsSuccessStatusCode)throw new Exception("MCP resource metadata unavailable");
  var resource=JsonNode.Parse(await resourceResponse.Content.ReadAsStringAsync());
  if(resource?["resource"]?.GetValue<string>()!=url.TrimEnd('/')+"/mcp")throw new Exception("MCP resource URL does not match BYOT domain");
 }
 static bool IsPublicAddress(IPAddress ip){
  if(IPAddress.IsLoopback(ip))return false;
  if(ip.IsIPv4MappedToIPv6)ip=ip.MapToIPv4();
  if(ip.AddressFamily==AddressFamily.InterNetworkV6){
   var b=ip.GetAddressBytes();return !ip.IsIPv6LinkLocal&&!ip.IsIPv6SiteLocal&&!ip.IsIPv6Multicast&&!ip.Equals(IPAddress.IPv6Any)&&!ip.Equals(IPAddress.IPv6None)&&(b[0]&0xfe)!=0xfc;
  }
  if(ip.AddressFamily!=AddressFamily.InterNetwork)return false;
  var a=ip.GetAddressBytes();
  return a[0]!=0&&a[0]!=10&&a[0]!=127&&a[0]<224&&!(a[0]==169&&a[1]==254)&&!(a[0]==172&&a[1]>=16&&a[1]<=31)&&!(a[0]==192&&a[1]==168)&&!(a[0]==100&&a[1]>=64&&a[1]<=127)&&!(a[0]==192&&a[1]==0)&&!(a[0]==192&&a[1]==0&&a[2]==2)&&!(a[0]==198&&a[1]==18)&&!(a[0]==198&&a[1]==19)&&!(a[0]==198&&a[1]==51&&a[2]==100)&&!(a[0]==203&&a[1]==0&&a[2]==113);
 }
 void FinishSetup(){
  if(!RequirementsOK()){
   MessageBox.Show("Required components are missing. Check the status panel before continuing.","HomeMCP setup");
   return;
  }
  // First launch is explicit: no unmanaged tunnel or DNS modifications.
  Start();
  _=Task.Run(async ()=>{
   for(var i=0;i<12;i++){
    await Task.Delay(1000);
    try{
     if(!File.Exists(ConfigPath))continue;
     var config=JsonNode.Parse(await File.ReadAllTextAsync(ConfigPath)) as JsonObject;
     var port=config?["port"]?.GetValue<int>()??0;
     if(port<1)continue;
     using var response=await http.GetAsync("http://127.0.0.1:"+port+"/health");
     if(response.IsSuccessStatusCode){
      var data=JsonNode.Parse(await response.Content.ReadAsStringAsync()) as JsonObject;
      if(data?["ok"]?.GetValue<bool>()==true){
       try{await VerifyByotConnection();}catch(Exception ex){
        if(settings is {IsHandleCreated:true})settings.BeginInvoke((Action)(()=>MessageBox.Show("BYOT verification failed: "+ex.Message+"\nFix your HTTPS tunnel and retry. Setup was not completed.","HomeMCP setup")));
        return;
       }
       await File.WriteAllTextAsync(Path.Combine(dir,"setup-complete.marker"),DateTimeOffset.UtcNow.ToString("O"));
       if(settings is {IsHandleCreated:true})settings.BeginInvoke((Action)(()=>{_ = ProbeHealth();MessageBox.Show("HomeMCP is healthy. Setup completed; monitoring continues in the tray.","HomeMCP setup");}));
       return;
      }
     }
    }catch{}
   }
   if(settings is {IsHandleCreated:true})settings.BeginInvoke((Action)(()=>MessageBox.Show("Host did not become healthy. Check startup-errors.log; setup remains incomplete.","HomeMCP setup")));
  });
 }
 void Start(){
  if(Running)return;
  try{
   var node=Path.Combine(app,"runtime","node.exe");
   var server=Path.Combine(app,"src","server.mjs");
   if(!File.Exists(node)||!File.Exists(server))throw new FileNotFoundException("Installed Host missing");
   if(!File.Exists(ConfigPath)){
     var provision=Path.Combine(app,"scripts","provision-installed.ps1");
     var powershell=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell","v1.0","powershell.exe");
     var setup=new ProcessStartInfo(powershell){UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=app};
     foreach(var arg in new[]{"-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",provision,"-AppDir",app,"-ConfigPath",ConfigPath})setup.ArgumentList.Add(arg);
     using var process=Process.Start(setup)??throw new InvalidOperationException("Provisioning failed to start");
     if(!process.WaitForExit(30000)||process.ExitCode!=0||!File.Exists(ConfigPath))
       throw new InvalidOperationException("Initial configuration provisioning failed");
   }
   var startInfo=new ProcessStartInfo(node){
    UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=app,
   };
   startInfo.ArgumentList.Add(server);
   startInfo.ArgumentList.Add("--config");
   startInfo.ArgumentList.Add(ConfigPath);
   host=supervisor.Start(startInfo);
   if(host==null)throw new InvalidOperationException("Failed to spawn HomeMCP host");
   TryStartOracleTunnel();
   host.EnableRaisingEvents=true;
   host.Exited+=(_,_)=>{try{if(settings is {IsHandleCreated:true})settings.BeginInvoke((Action)RefreshStatus);}catch{}};
  } catch(Exception ex){
    try{File.AppendAllText(Path.Combine(dir,"manager-startup-errors.log"),DateTimeOffset.UtcNow.ToString("O")+" "+ex.GetType().Name+": "+ex.Message+Environment.NewLine);}catch{}
    MessageBox.Show(ex.Message,"HomeMCP start failed",MessageBoxButtons.OK,MessageBoxIcon.Error);
   }
  RefreshStatus();
 }
 void TryStartOracleTunnel(){
  var node=Path.Combine(app,"runtime","node.exe");
  var helper=Path.Combine(app,"scripts","oracle-manager-config.mjs");
  var dll=Path.Combine(AppContext.BaseDirectory,"homemcp-frp.dll");
  if(!File.Exists(helper)||!File.Exists(dll))return;
  try{
   var info=new ProcessStartInfo(node){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=app};
   info.ArgumentList.Add(helper);
   using var reader=Process.Start(info);
   if(reader==null)return;
   var config=reader.StandardOutput.ReadToEnd();
   if(!reader.WaitForExit(10000)){reader.Kill();return;}
   if(reader.ExitCode==2)return;
   if(reader.ExitCode!=0||string.IsNullOrWhiteSpace(config))throw new InvalidOperationException("Oracle tunnel config invalid");
   FrpTunnel.Start(config);
   oracleTunnelStarted=true;
   var gateway=new ProcessStartInfo(node){UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=app};
   gateway.ArgumentList.Add(Path.Combine(app,"scripts","oracle-run.mjs"));
   gateway.ArgumentList.Add("gateway");
   oracleGateway=supervisor.Start(gateway);
  }catch(Exception ex){LogRecovery("oracle_tunnel_start_failed:"+ex.GetType().Name);StopOracleTunnel();}
 }
 void StopOracleTunnel(){
  if(oracleTunnelStarted){try{FrpTunnel.Stop();}catch(Exception ex){LogRecovery("oracle_tunnel_stop_failed:"+ex.GetType().Name);}oracleTunnelStarted=false;}
  if(oracleGateway!=null){try{if(!oracleGateway.HasExited)oracleGateway.Kill(entireProcessTree:true);}catch{}oracleGateway.Dispose();oracleGateway=null;}
 }
 void Stop(){
  StopOracleTunnel();
  try{
   if(host!=null){supervisor.Stop(host);if(!host.HasExited)host.WaitForExit(5000);}
  }catch(Exception ex){MessageBox.Show(ex.Message,"HomeMCP stop failed");}
  finally{host?.Dispose();host=null;LastHealth="Stopped";}
  RefreshStatus();
 }
 JsonObject ReadState(){
  if(!File.Exists(StatePath))return new JsonObject {["mode"]="local",["remoteEnabled"]=false};
  try {return JsonNode.Parse(File.ReadAllText(StatePath)) as JsonObject ?? new JsonObject();}catch{return new JsonObject();}
 }
 string Hostname=>ReadState()["hostname"]?.GetValue<string>()??"";
 void SaveHostname(){
  if(hostnameBox is null)return;
  var raw=hostnameBox.Text.Trim();
  if(!Uri.TryCreate(raw,UriKind.Absolute,out var uri)||uri.Scheme!="https"||uri.UserInfo!=""||uri.Port!=443||uri.AbsolutePath!="/"||uri.Query!=""||uri.Fragment!=""){
   MessageBox.Show("Enter a full HTTPS domain URL with no path, query, or credentials, for example https://pc.example.com","HomeMCP Domain");return;
  }
  var origin=uri.GetLeftPart(UriPartial.Authority);
  try{
   if(!File.Exists(ConfigPath))throw new InvalidOperationException("HomeMCP must be initialized before binding a domain");
   var config=JsonNode.Parse(File.ReadAllText(ConfigPath)) as JsonObject ?? throw new Exception("Invalid Host config");
   var old=config["publicUrl"]?.GetValue<string>()??config["security"]?["rpOrigin"]?.GetValue<string>()??"";
   if(String.Equals(old,origin,StringComparison.OrdinalIgnoreCase)){
    MessageBox.Show("Already bound to "+origin,"HomeMCP");return;
   }
   var msg="Switch this HomeMCP to "+origin+"?\n\nThis changes the OAuth issuer and Passkey domain. Previously registered Passkeys and OAuth sessions for the OLD domain will not work on the new domain. You will need to register a Passkey for the new domain.\n\nConfigure DNS and tunnel routing separately before connecting ChatGPT. Existing Bearer tokens are preserved.";
   if(MessageBox.Show(msg,"Rebind HomeMCP domain",MessageBoxButtons.YesNo,MessageBoxIcon.Warning)!=DialogResult.Yes)return;
   var backup=ConfigPath+".before-domain-rebind-"+DateTime.UtcNow.ToString("yyyyMMddHHmmss")+".bak";
   File.Copy(ConfigPath,backup);
   config["publicUrl"]=origin;
   var security=config["security"] as JsonObject ?? new JsonObject();
   config["security"]=security;
   security["rpOrigin"]=origin;
   security["rpID"]=uri.Host;
   var oauth=config["oauth"] as JsonObject ?? new JsonObject();
   config["oauth"]=oauth;
   oauth["enabled"]=true;
   oauth.Remove("issuer");
   var tmp=ConfigPath+".rebind.tmp";
   File.WriteAllText(tmp,config.ToJsonString(new JsonSerializerOptions{WriteIndented=true}));
   File.Move(tmp,ConfigPath,true);
   var obj=ReadState();obj["hostname"]=uri.Host;obj["url"]=origin;obj["mode"]="external";obj["remoteEnabled"]=false;
   File.WriteAllText(StatePath,obj.ToJsonString(new JsonSerializerOptions{WriteIndented=true}));
   Stop();Start();
   MessageBox.Show("Domain rebound to "+origin+".\n\nOpen Set up Passkey (QR) after the new HTTPS address is accessible. Old domain credentials remain backed up. No tunnel or server account was changed.","HomeMCP");
  }catch(Exception ex){MessageBox.Show("Domain rebind failed: "+ex.Message,"HomeMCP");}
 }
 void LaunchNetworkWizard(){
  try{
   Process.Start(new ProcessStartInfo("powershell.exe"){
    UseShellExecute=true,Arguments="-NoProfile -ExecutionPolicy Bypass -File \""+Path.Combine(app,"scripts","network-setup.ps1")+"\" -Force"
   });
  }catch(Exception ex){MessageBox.Show(ex.Message,"Network setup");}
 }

 async Task DiscoverCloudflare(){
  var result="Cloudflare tunnel: not detected. Local-only remains active.";
  try{
   var file=@"\\wsl.localhost\Ubuntu-22.04\home\shootingsyh\.cloudflared\config.yml";
   if(File.Exists(file)){
    var content=await File.ReadAllTextAsync(file);
    var tunnel=System.Text.RegularExpressions.Regex.Match(content,@"(?m)^tunnel:\s*(\S+)").Groups[1].Value;
    var hosts=System.Text.RegularExpressions.Regex.Matches(content,@"(?m)^\s*- hostname:\s*([^\s]+)");
    if(tunnel.Length>0)result="Existing WSL tunnel: "+tunnel+" (in use by "+hosts.Count+" hostnames).\nNo route changes. Cloudflare Access: not verified.";
   }
  }catch(Exception ex){result="Cloudflare discovery unavailable: "+ex.GetType().Name+". No changes made.";}
  if(cloudflareStatus is {IsDisposed:false})cloudflareStatus.Text=result;
 }
 void SaveCloudflarePlan(){
  if(hostnameBox is null)return;
  var name=hostnameBox.Text.Trim();
  if(!Uri.TryCreate(name,UriKind.Absolute,out var uri)||uri.Scheme!="https"||uri.UserInfo!=""||uri.Port!=443||uri.AbsolutePath!="/"||uri.Query!=""||uri.Fragment!=""){
   MessageBox.Show("Enter an HTTPS host URL without path or credentials, e.g. https://homemcp.example.com");return;
  }
  var state=ReadState();
  state["mode"]="cloudflare-planned";
  state["hostname"]=uri.Host;
  state["url"]=uri.GetLeftPart(UriPartial.Authority);
  state["tunnel"]="opencode";
  state["source"]="wsl:Ubuntu-22.04";
  state["remoteEnabled"]=false;
  state["accessVerified"]=false;
  File.WriteAllText(StatePath,state.ToJsonString(new JsonSerializerOptions{WriteIndented=true}));
  if(cloudflareStatus is {IsDisposed:false})cloudflareStatus.Text="Cloudflare plan saved: "+uri.Host+"\nNot connected: Cloudflare Access policy and remote authentication have not been verified.";
  _=ProbeHealth();
 }
 async Task OpenPasskeySetup(){
  try{
   if(!Running)Start();
   var c=JsonNode.Parse(await File.ReadAllTextAsync(ConfigPath)) as JsonObject;
   var port=c?["port"]?.GetValue<int>()??0;
   var admin=c?["security"]?["adminToken"]?.GetValue<string>();
   if(port<=0||String.IsNullOrEmpty(admin))throw new Exception("HomeMCP local Host or administrator credentials unavailable");
   using var request=new HttpRequestMessage(HttpMethod.Post,"http://127.0.0.1:"+port+"/admin/enrollment");
   request.Headers.Authorization=new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer",admin);
   using var response=await http.SendAsync(request);
   if(!response.IsSuccessStatusCode)throw new Exception("Unable to create a one-time Passkey invitation (HTTP "+(int)response.StatusCode+")");
   var obj=JsonNode.Parse(await response.Content.ReadAsStringAsync());
   var publicLink=obj?["url"]?.GetValue<string>()??throw new Exception("Enrollment URL missing");
   var invite=new Uri(publicLink);
   var code=System.Web.HttpUtility.ParseQueryString(invite.Query)["enroll"];
   if(String.IsNullOrEmpty(code))throw new Exception("Enrollment code missing");
   var localUrl="http://127.0.0.1:"+port+"/setup?enroll="+Uri.EscapeDataString(code);
   Process.Start(new ProcessStartInfo(localUrl){UseShellExecute=true});
  }catch(Exception ex){MessageBox.Show("Passkey setup could not start: "+ex.Message,"HomeMCP");}
 }
 void OpenPasskeyManagement(){
  try{var c=JsonNode.Parse(File.ReadAllText(ConfigPath));var port=c?["port"]?.GetValue<int>()??0;
   if(port==0)throw new Exception("Host not configured");
   Process.Start(new ProcessStartInfo("http://127.0.0.1:"+port+"/passkeys"){UseShellExecute=true});
  }catch(Exception ex){MessageBox.Show(ex.Message,"HomeMCP");}
 }
 void OpenSettings(){
  if(settings is {IsDisposed:false}){settings.Activate();return;}
  var form=new Form{Text=SetupDone?"HomeMCP Settings and Health":"HomeMCP First-run Setup",Width=690,Height=760,StartPosition=FormStartPosition.CenterScreen,MinimumSize=new Size(660,700)};
  settings=form;
  var layout=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=1,RowCount=15,Padding=new Padding(18),AutoScroll=true};
  layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,36));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,48));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,25));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,180));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,45));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,28));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,38));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,48));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,65));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,48));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,26));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,75));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,45));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,92));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,35));
  statusLabel=new Label{Text=Status,AutoSize=true,Font=new Font("Segoe UI",11,FontStyle.Bold)};layout.Controls.Add(statusLabel);
  var actions=new FlowLayoutPanel{Dock=DockStyle.Fill};
  var start=new Button{Text="Start",Width=100};start.Click+=(_,_)=>{Start();_=ProbeHealth();};
  var stop=new Button{Text="Stop",Width=100};stop.Click+=(_,_)=>{Stop();_=ProbeHealth();};
  var restart=new Button{Text="Restart",Width=100};restart.Click+=(_,_)=>{Stop();Start();_=ProbeHealth();};
  var refresh=new Button{Text="Check now",Width=110};refresh.Click+=async (_,_)=>await ProbeHealth();
  actions.Controls.AddRange([start,stop,restart,refresh]);layout.Controls.Add(actions);
  layout.Controls.Add(new Label{Text="Component diagnostics (refreshes every 5 seconds)",AutoSize=true});
  componentsLabel=new Label{Text=ComponentReport(),Dock=DockStyle.Fill,Font=new Font("Consolas",9),AutoSize=false};
  layout.Controls.Add(componentsLabel);
  var explain=new Label{Text="1. Check runtime components. 2. Choose local-only or record an HTTPS address. 3. Start and verify the host.",Dock=DockStyle.Fill,AutoSize=false};layout.Controls.Add(explain);
  var connectionOptions=new FlowLayoutPanel{Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoSize=false};
  connectionOptions.Controls.Add(new Label{Text="Connection setup (choose one existing mode)",AutoSize=true,Font=new Font("Segoe UI",9,FontStyle.Bold)});
  var choiceActions=new FlowLayoutPanel{Width=600,Height=39};
  var managedChoice=new Button{Text="HomeMCP Managed (paid)",AutoSize=true};
  managedChoice.Click+=(_,_)=>MessageBox.Show("Managed mode includes a HomeMCP subdomain and our FRP tunnel. Enrollment is currently available through the Oracle setup command. Existing local enrollment and credentials are retained across normal reinstalls. Recovery on a wiped system still requires a cloud recovery endpoint.","Managed connection");
  var ownChoice=new Button{Text="Bring Your Own Tunnel (free)",AutoSize=true};
  ownChoice.Click+=(_,_)=>{MessageBox.Show("Configure your own HTTPS tunnel first, then enter its public HTTPS origin below and click Bind / change domain. HomeMCP does not manage your tunnel credentials.","Self-hosted connection");};
  choiceActions.Controls.AddRange([managedChoice,ownChoice]);connectionOptions.Controls.Add(choiceActions);
  var recoveryActions=new FlowLayoutPanel{Width=600,Height=33};
  var localRestore=new Button{Text="Restore saved local setup",AutoSize=true};
  localRestore.Click+=(_,_)=>{
   var exists=File.Exists(ConfigPath);
   var message=exists?"Existing HomeMCP configuration found. Reinstall preserves this configuration. Use Recheck and start to resume. Managed Tunnel credentials also require the original Windows user DPAPI keys.":"No existing local configuration was found. Domain recovery after a wiped OS is not supported yet; do not register a replacement paid domain. Keep your Recovery Key safe for the upcoming cloud recovery flow.";
   MessageBox.Show(message,"Restore HomeMCP");
  };
  recoveryActions.Controls.Add(localRestore);connectionOptions.Controls.Add(recoveryActions);
  layout.Controls.Add(connectionOptions);
  layout.Controls.Add(new Label{Text="Existing setups are preserved. Full OS-reinstall domain recovery requires a separate cloud-side Recovery Key API.",AutoSize=true});
  layout.Controls.Add(new Label{Text="HomeMCP public HTTPS URL (change OAuth + Passkey domain; configure tunnel separately)",AutoSize=true});
  hostnameBox=new TextBox{Dock=DockStyle.Fill,Text=ReadState()["url"]?.GetValue<string>()??""};layout.Controls.Add(hostnameBox);
  var passkeyActions=new FlowLayoutPanel{Dock=DockStyle.Fill};
  var setupPasskey=new Button{Text="Set up Passkey (QR)",AutoSize=true};setupPasskey.Click+=async (_,_)=>await OpenPasskeySetup();
  var managePasskeys=new Button{Text="Devices / Add Device",AutoSize=true};managePasskeys.Click+=(_,_)=>OpenPasskeyManagement();
  passkeyActions.Controls.AddRange([setupPasskey,managePasskeys]);
  layout.Controls.Add(passkeyActions);
  var network=new FlowLayoutPanel{Dock=DockStyle.Fill};
  var save=new Button{Text="Bind / change domain",AutoSize=true};save.Click+=(_,_)=>SaveHostname();
  var cloud=new Button{Text="Advanced tunnel setup",AutoSize=true};cloud.Click+=(_,_)=>LaunchNetworkWizard();
  network.Controls.AddRange([save,cloud]);layout.Controls.Add(network);
  layout.Controls.Add(new Label{Text="Cloudflare Tunnel (optional; requires Access protection before publishing)",AutoSize=true});
  cloudflareStatus=new Label{Text="Checking existing Cloudflare configuration...",Dock=DockStyle.Fill,AutoSize=false};
  layout.Controls.Add(cloudflareStatus);
  var cfActions=new FlowLayoutPanel{Dock=DockStyle.Fill};
  var cfCheck=new Button{Text="Detect tunnel",AutoSize=true};cfCheck.Click+=async (_,_)=>await DiscoverCloudflare();
  var cfPlan=new Button{Text="Save Cloudflare plan",AutoSize=true};cfPlan.Click+=(_,_)=>SaveCloudflarePlan();
  cfActions.Controls.AddRange([cfCheck,cfPlan]);layout.Controls.Add(cfActions);
  _=DiscoverCloudflare();
  var foot=new FlowLayoutPanel{Dock=DockStyle.Fill};
  var finish=new Button{Text=SetupDone?"Recheck and start":"Finish setup and start",Width=210,Height=34};
  finish.Click+=(_,_)=>FinishSetup();foot.Controls.Add(finish);
  foot.Controls.Add(new Label{Text="Remote access remains OFF until secure setup is implemented.",AutoSize=true});
  layout.Controls.Add(foot);
  form.Controls.Add(layout);
  form.FormClosed+=(_,_)=>{statusLabel=null;componentsLabel=null;hostnameBox=null;cloudflareStatus=null;settings=null;};
  form.Show();
 }
 async Task PipeLoop(CancellationToken cancellation){
  while(!cancellation.IsCancellationRequested){
   try{
    using var pipe=new NamedPipeServerStream("HomeMCP-Manager",PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous|PipeOptions.CurrentUserOnly);
    await pipe.WaitForConnectionAsync(cancellation);
    using var reader=new StreamReader(pipe,System.Text.Encoding.UTF8,false,1024,true);
    using var writer=new StreamWriter(pipe,System.Text.Encoding.UTF8,1024,true){AutoFlush=true};
    var cmd=(await reader.ReadLineAsync(cancellation))?.Trim().ToLowerInvariant();
    var tcs=new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
    void Execute(){
     try{
      var result=cmd switch{
       "status"=>Status,
       "start"=>ApplyStart(),
       "stop"=>ApplyStop(),
       "restart"=>ApplyRestart(),
       "settings"=>ApplySettings(),
       _=>"ERROR unsupported command"
      };
      tcs.TrySetResult(result);
     }catch(Exception ex){tcs.TrySetResult("ERROR "+ex.Message);}
    }
    formDispatcher.BeginInvoke((Action)Execute);
    await writer.WriteLineAsync(await tcs.Task);
   }catch(OperationCanceledException){break;}
   catch(Exception){await Task.Delay(500,cancellation).ConfigureAwait(false);}
  }
 }
 readonly Control formDispatcher=new Control();
 string ApplyStart(){Start();return Status;}
 string ApplyStop(){Stop();return Status;}
 string ApplyRestart(){Stop();Start();return Status;}
 string ApplySettings(){OpenSettings();return "Settings opened";}
}
