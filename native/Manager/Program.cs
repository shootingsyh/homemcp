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
  using var single=new Mutex(true, Environment.GetEnvironmentVariable("HOMEMCP_UI_SMOKE")=="1"?@"Local\HomeMCP-Manager-UI-Smoke":@"Local\HomeMCP-Manager-SingleInstance", out bool owner);
  if(!owner)return;
  ApplicationConfiguration.Initialize();
  Application.Run(new TrayContext());
 }
}
sealed partial class TrayContext : ApplicationContext {
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
  menu.Items.Add("Open HomeMCP Manager",null,(_,_)=>OpenSettings());
  menu.Items.Add("Connect ChatGPT…",null,(_,_)=>OpenConnectionGuide(false));
  menu.Items.Add("Connect Muse…",null,(_,_)=>OpenConnectionGuide(true));
  menu.Items.Add("Start",null,(_,_)=>Start());
  menu.Items.Add("Stop",null,(_,_)=>Stop());
  menu.Items.Add("Restart",null,(_,_)=>{Stop();Start();});
  menu.Items.Add("Exit manager",null,(_,_)=>{Stop();cancel.Cancel();supervisor.Dispose();tray.Visible=false;ExitThread();});
  tray.ContextMenuStrip=menu;
  tray.DoubleClick+=(_,_)=>OpenSettings();
  if(Environment.GetEnvironmentVariable("HOMEMCP_UI_SMOKE")=="1"){
   // Real WinForms startup/layout check in an isolated CI runner: no Host, relay,
   // credentials or monitoring are started.
   var smokePage=Environment.GetEnvironmentVariable("HOMEMCP_UI_SMOKE_PAGE")??"wizard";
   OpenSetupWizard();
   if(smokePage=="dashboard"){settings?.Close();OpenSettings(smoke:true);}
   var probe=new System.Windows.Forms.Timer{Interval=500};
   probe.Tick+=(_,_)=>{
    probe.Stop();
    try{
     if(settings is null||!settings.Visible||settings.Controls.Count==0)throw new Exception("manager_ui_not_visible");
     var controls=new System.Collections.Generic.List<Control>();
     void Collect(Control root){controls.Add(root);foreach(Control child in root.Controls)Collect(child);}
     Collect(settings);
     if(smokePage=="dashboard"){
      if(!controls.OfType<Button>().Any(x=>x.Text=="Connect ChatGPT · Step by step"))throw new Exception("dashboard_chatgpt_missing");
      if(!controls.OfType<Button>().Any(x=>x.Text=="Connect Muse · Copy prompt"))throw new Exception("dashboard_muse_missing");
      if(!controls.OfType<Button>().Any(x=>x.Text=="Show diagnostics"))throw new Exception("dashboard_diagnostics_missing");
      var guide=new ConnectionGuideForm(false,"https://example.com/mcp");
      guide.Show();
      if(!guide.Controls.OfType<TableLayoutPanel>().Any())throw new Exception("connection_guide_missing");
      var guideImage=Environment.GetEnvironmentVariable("HOMEMCP_UI_SMOKE_SCREENSHOT");
      if(!String.IsNullOrEmpty(guideImage)){
       using var bitmap=new Bitmap(guide.Width,guide.Height);
       guide.DrawToBitmap(bitmap,new Rectangle(0,0,bitmap.Width,bitmap.Height));
       bitmap.Save(guideImage+".guide.png",System.Drawing.Imaging.ImageFormat.Png);
      }
      guide.Close();
     }else{
     if(!controls.OfType<Button>().Any(x=>x.Text=="Continue"))throw new Exception("wizard_continue_missing");
     if(!controls.OfType<Label>().Any(x=>x.Text.Contains("Choose connection")))throw new Exception("wizard_first_page_missing");
     if(controls.OfType<Button>().Any(x=>x.Text.Contains("Passkey")||x.Text.Contains("Finish")))throw new Exception("wizard_future_steps_leaked");
     controls.OfType<Button>().First(x=>x.Text=="Continue").PerformClick();
     controls.Clear();Collect(settings);
     if(!controls.OfType<Label>().Any(x=>x.Text.Contains("Verify your tunnel")))throw new Exception("wizard_step_two_missing");
     if(controls.OfType<Button>().Any(x=>x.Text.Contains("Passkey")))throw new Exception("wizard_passkey_visible_too_early");
     }
     var screenshot=Environment.GetEnvironmentVariable("HOMEMCP_UI_SMOKE_SCREENSHOT");
     if(!String.IsNullOrEmpty(screenshot)){
      using var bitmap=new Bitmap(settings.Width,settings.Height);
      settings.DrawToBitmap(bitmap,new Rectangle(0,0,bitmap.Width,bitmap.Height));
      bitmap.Save(screenshot,System.Drawing.Imaging.ImageFormat.Png);
     }
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
  lines.Add("Desktop worker: "+(File.Exists(Path.Combine(app,"workers","windows-mcp","python.exe"))?"Installed":"MISSING"));
  lines.Add("Host configuration: "+(File.Exists(ConfigPath)?"Created":"Not created (generated on start)"));
  lines.Add("Network: "+(ReadState()["remoteEnabled"]?.GetValue<bool>()==true?"Remote requested":"Local only (safe default)"));
  lines.Add("Oracle tunnel: "+(oracleTunnelStarted?FrpTunnel.Status():"Not configured / stopped"));
  lines.Add("Host health: "+LastHealth);
  return string.Join(Environment.NewLine,lines);
 }
 bool RequirementsOK()=>File.Exists(Path.Combine(app,"runtime","node.exe"))
  &&File.Exists(Path.Combine(app,"workers","playwright","cli.mjs"))
  &&File.Exists(Path.Combine(app,"workers","windows-mcp","python.exe"))
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
 void MigratePackagedDesktopWorker(){
  // Preserve user-customized workers. Upgrade only the old HomeMCP PyInstaller path.
  if(!File.Exists(ConfigPath))return;
  var bundled=Path.Combine(app,"workers","windows-mcp","python.exe");
  if(!File.Exists(bundled))return;
  var data=JsonNode.Parse(File.ReadAllText(ConfigPath)) as JsonObject;
  if(data?["workers"] is not JsonArray workers)return;
  var changed=false;
  foreach(var entry in workers){
   if(entry is not JsonObject worker || worker["name"]?.GetValue<string>()!="desktop")continue;
   var old=worker["command"]?.GetValue<string>()??"";
   if(!old.EndsWith(Path.Combine("workers","windows-mcp.exe"),StringComparison.OrdinalIgnoreCase))continue;
   worker["command"]=bundled;
   var args=worker["args"] as JsonArray;
   var next=new JsonArray("-m","windows_mcp");
   if(args!=null)foreach(var arg in args)next.Add(arg?.DeepClone());
   worker["args"]=next;
   changed=true;
  }
  if(!changed)return;
  File.Copy(ConfigPath,ConfigPath+".before-python-worker",true);
  var tmp=ConfigPath+".worker-migrate.tmp";
  File.WriteAllText(tmp,data!.ToJsonString(new JsonSerializerOptions{WriteIndented=true}));
  File.Move(tmp,ConfigPath,true);
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
   MigratePackagedDesktopWorker();
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

 async Task<(bool hasOrigin,int passkeys,string origin)> ReadWizardStatus(){
  if(!File.Exists(ConfigPath))return (false,0,"");
  var config=JsonNode.Parse(await File.ReadAllTextAsync(ConfigPath));
  var port=config?["port"]?.GetValue<int>()??0;
  var token=config?["security"]?["adminToken"]?.GetValue<string>()??"";
  if(port<1||String.IsNullOrEmpty(token))throw new Exception("Local Host is not configured.");
  using var req=new HttpRequestMessage(HttpMethod.Get,"http://127.0.0.1:"+port+"/admin/setup-status");
  req.Headers.Authorization=new AuthenticationHeaderValue("Bearer",token);
  using var response=await http.SendAsync(req);
  response.EnsureSuccessStatusCode();
  var obj=JsonNode.Parse(await response.Content.ReadAsStringAsync());
  var origin=obj?["publicOrigin"]?.GetValue<string>()??"";
  var count=obj?["passkeyCount"]?.GetValue<int>()??0;
  return(origin.StartsWith("https://",StringComparison.OrdinalIgnoreCase),count,origin);
 }
 void OpenSettings(bool smoke=false){
  if(settings is {IsDisposed:false}){settings.Activate();return;}
  if(!SetupDone&&!smoke){OpenSetupWizard();return;}
  var form=new Form{Text="HomeMCP Manager",Width=760,Height=680,MinimumSize=new Size(660,580),AutoScaleMode=AutoScaleMode.Dpi,StartPosition=FormStartPosition.CenterScreen};
  settings=form;
  var content=new FlowLayoutPanel{Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown,WrapContents=false,Padding=new Padding(22),AutoScroll=true};
  content.Controls.Add(new Label{Text="HomeMCP",AutoSize=true,Font=new Font("Segoe UI",20,FontStyle.Bold)});
  content.Controls.Add(new Label{Text="Connect your AI client to use this computer remotely.",AutoSize=true});
  statusLabel=new Label{Text=Status,AutoSize=true,MaximumSize=new Size(640,0),Font=new Font("Segoe UI",10,FontStyle.Bold)};
  content.Controls.Add(statusLabel);
  AddConnectionSection(content);
  var actions=new FlowLayoutPanel{Width=630,AutoSize=true,WrapContents=true};
  var start=new Button{Text="Start",Width=100,AutoSize=true,MinimumSize=new Size(100,32)};start.Click+=(_,_)=>{Start();_=ProbeHealth();};
  var stop=new Button{Text="Stop",Width=100,AutoSize=true,MinimumSize=new Size(100,32)};stop.Click+=(_,_)=>{Stop();_=ProbeHealth();};
  var restart=new Button{Text="Restart",Width=100,AutoSize=true,MinimumSize=new Size(100,32)};restart.Click+=(_,_)=>{Stop();Start();_=ProbeHealth();};
  var check=new Button{Text="Check Status",Width=115,AutoSize=true,MinimumSize=new Size(115,32)};check.Click+=async (_,_)=>await ProbeHealth();
  actions.Controls.AddRange([start,stop,restart,check]);content.Controls.Add(actions);
  var passkeyActions=new FlowLayoutPanel{Width=630,AutoSize=true,WrapContents=true};
  var add=new Button{Text="Connect another device",Width=200,AutoSize=true,MinimumSize=new Size(200,32)};add.Click+=async (_,_)=>await OpenPasskeySetup();
  var manage=new Button{Text="Manage devices",Width=145,AutoSize=true,MinimumSize=new Size(145,32)};manage.Click+=(_,_)=>OpenPasskeyManagement();
  passkeyActions.Controls.AddRange([add,manage]);content.Controls.Add(passkeyActions);
  var wizard=new Button{Text="Restart Setup Wizard…",Width=200,Height=35};
  wizard.Click+=(_,_)=>{
   if(MessageBox.Show("Return to the first setup page? Your Host config, credentials and Passkeys will be preserved. Domain changes need a deliberate rebind.","Restart setup",MessageBoxButtons.YesNo,MessageBoxIcon.Question)!=DialogResult.Yes)return;
   File.Delete(Path.Combine(dir,"setup-complete.marker"));
   form.Close();OpenSetupWizard();
  };
  content.Controls.Add(wizard);
  var details=new Button{Text="Show diagnostics",AutoSize=true};
  componentsLabel=new Label{Text=ComponentReport(),AutoSize=true,MaximumSize=new Size(640,0),Font=new Font("Consolas",9),Visible=false};
  details.Click+=(_,_)=>{componentsLabel.Visible=!componentsLabel.Visible;details.Text=componentsLabel.Visible?"Hide diagnostics":"Show diagnostics";};
  content.Controls.Add(details);content.Controls.Add(componentsLabel);
  content.SizeChanged+=(_,_)=>{
   var width=Math.Max(200,content.ClientSize.Width-content.Padding.Horizontal-SystemInformation.VerticalScrollBarWidth-8);
   foreach(Control child in content.Controls)if(child is Label label)label.MaximumSize=new Size(width,0);
  };
  form.Controls.Add(content);
  form.FormClosed+=(_,_)=>{settings=null;statusLabel=null;componentsLabel=null;};
  form.Show();
 }
 void OpenSetupWizard(){
  if(settings is {IsDisposed:false}){settings.Activate();return;}
  var form=new Form{Text="HomeMCP Setup Wizard",Width=680,Height=460,MinimumSize=new Size(625,400),StartPosition=FormStartPosition.CenterScreen};
  settings=form;
  var layout=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=1,RowCount=4,Padding=new Padding(24)};
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,45));
  layout.RowStyles.Add(new RowStyle(SizeType.Percent,100));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,48));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,55));
  var title=new Label{Dock=DockStyle.Fill,Font=new Font("Segoe UI",15,FontStyle.Bold)};
  var page=new Panel{Dock=DockStyle.Fill};
  var footer=new FlowLayoutPanel{Dock=DockStyle.Fill,FlowDirection=FlowDirection.RightToLeft};
  var next=new Button{Text="Next",Width=165,Height=33};
  var back=new Button{Text="Back",Width=100,Height=33};
  var message=new Label{Dock=DockStyle.Fill,Text="Existing credentials and local data are preserved.",AutoEllipsis=true};
  footer.Controls.Add(next);footer.Controls.Add(back);
  layout.Controls.Add(title,0,0);layout.Controls.Add(page,0,1);layout.Controls.Add(footer,0,2);layout.Controls.Add(message,0,3);
  form.Controls.Add(layout);
  int step=0;bool busy=false;string choice="external";
  TextBox? domainBox=null;
  void SetBusy(bool value){busy=value;next.Enabled=!value;back.Enabled=!value;}
  void ShowStep(){
   page.Controls.Clear();
   title.Text=step switch{0=>"1 / 3   Choose connection",1=>"2 / 3   Verify your tunnel",_=>"3 / 3   Register Passkey"};
   back.Visible=step>0;
   next.Text=step switch{0=>"Continue",1=>"Verify and Continue",_=>"Verify registration and Finish"};
   var body=new FlowLayoutPanel{Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoScroll=true};
   page.Controls.Add(body);
   if(step==0){
    var byot=new RadioButton{Text="Bring Your Own Tunnel (free)",Checked=choice=="external",AutoSize=true};
    var managed=new RadioButton{Text="HomeMCP Managed (existing enrollment)",Checked=choice=="managed",AutoSize=true};
    byot.CheckedChanged+=(_,_)=>{if(byot.Checked)choice="external";};
    managed.CheckedChanged+=(_,_)=>{if(managed.Checked)choice="managed";};
    body.Controls.Add(byot);body.Controls.Add(managed);
    body.Controls.Add(new Label{Width=570,Height=90,Text="BYOT: configure your own public HTTPS domain and tunnel. Managed: use a previously enrolled HomeMCP domain. New paid Managed enrollment is not yet available from this wizard."});
   }else if(step==1){
    body.Controls.Add(new Label{Width=565,Height=60,Text=choice=="external"?"Configure your own HTTPS tunnel so it routes to this local HomeMCP, then bind and verify the public origin.":"Only existing Managed enrollments can continue. This wizard cannot purchase or register a new Managed domain."});
    var existing=ReadState()["url"]?.GetValue<string>()??"";
    if(String.IsNullOrWhiteSpace(existing)){
     try{existing=JsonNode.Parse(File.ReadAllText(ConfigPath))?["publicUrl"]?.GetValue<string>()??"";}catch{}
    }
    domainBox=new TextBox{Width=560,Text=existing};
    body.Controls.Add(domainBox);
    if(choice=="external"){
     body.Controls.Add(new Label{Width=570,Height=65,Text="Verification checks DNS, TLS, a local nonce challenge, OAuth issuer and MCP resource metadata. The next page is locked until verification passes."});
    }else{
     domainBox.ReadOnly=true;
     body.Controls.Add(new Label{Width=570,Height=65,Text="An existing Managed domain and local Host identity are required. Confirm that the Managed tunnel is active before registering a Passkey."});
    }
   }else{
    body.Controls.Add(new Label{Width=570,Height=75,Text="The public HTTPS domain is configured. Scan the QR code to register a trusted device. You cannot finish until the Host reports a registered Passkey."});
    var qr=new Button{Text="Open Passkey Setup QR",Width=225,Height=40};
    qr.Click+=async (_,_)=>await OpenPasskeySetup();
    body.Controls.Add(qr);
    body.Controls.Add(new Label{Width=570,Height=60,Text="After registering successfully in the browser, click Verify registration and Finish."});
   }
  }
  back.Click+=(_,_)=>{if(busy)return;step=Math.Max(0,step-1);ShowStep();};
  next.Click+=async (_,_)=>{
   if(busy)return;
   SetBusy(true);
   try{
    if(step==0){
     if(Environment.GetEnvironmentVariable("HOMEMCP_UI_SMOKE")=="1"){step=1;ShowStep();return;}
     if(!Running)Start();
     if(choice=="managed" && !File.Exists(ConfigPath))throw new Exception("Managed enrollment is not configured on this computer.");
     step=1;ShowStep();
    }else if(step==1){
     var origin=domainBox?.Text.Trim()??"";
     if(choice=="external"){
      if(!Uri.TryCreate(origin,UriKind.Absolute,out var uri)||uri.Scheme!="https"||uri.AbsolutePath!="/"||uri.Query.Length>0||uri.Fragment.Length>0)throw new Exception("Enter a bare HTTPS origin such as https://mcp.example.com");
      var current=ReadState()["url"]?.GetValue<string>()??"";
      if(!String.Equals(current,origin,StringComparison.OrdinalIgnoreCase)){
       // SaveHostname is the existing domain-rebind implementation. Do not alter
       // user configuration if they cancel its explicit confirmation dialog.
       hostnameBox=domainBox;
       SaveHostname();
       hostnameBox=null;
      }
      var saved=ReadState()["url"]?.GetValue<string>()??"";
      if(!String.Equals(saved,origin,StringComparison.OrdinalIgnoreCase))throw new Exception("Domain binding was not completed.");
      await VerifyByotConnection();
     }else{
      var config=JsonNode.Parse(await File.ReadAllTextAsync(ConfigPath));
      var existing=config?["publicUrl"]?.GetValue<string>()??"";
      if(!existing.StartsWith("https://")||!String.Equals(existing,origin,StringComparison.OrdinalIgnoreCase))throw new Exception("No matching Managed HTTPS enrollment found.");
     }
     var status=await ReadWizardStatus();
     if(!status.hasOrigin)throw new Exception("Local Host has not published a valid HTTPS origin.");
     step=2;ShowStep();message.Text="Tunnel configuration checked. Register your Passkey.";
    }else{
     var status=await ReadWizardStatus();
     if(!status.hasOrigin||status.passkeys<1)throw new Exception("First Passkey registration is not complete yet. Open QR, register, then verify again.");
     await File.WriteAllTextAsync(Path.Combine(dir,"setup-complete.marker"),DateTimeOffset.UtcNow.ToString("O"));
     form.Close();OpenSettings();
    }
   }catch(Exception ex){message.Text=ex.Message;MessageBox.Show(ex.Message,"HomeMCP Setup",MessageBoxButtons.OK,MessageBoxIcon.Warning);}
   finally{SetBusy(false);}
  };
  ShowStep();
  form.FormClosed+=(_,_)=>{if(settings==form)settings=null;hostnameBox=null;};
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

