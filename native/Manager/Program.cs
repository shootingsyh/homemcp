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
 CancellationTokenSource cancel=new();
 Form? settings;
 Label? statusLabel;
 Label? componentsLabel;
 readonly System.Windows.Forms.Timer monitor=new(){Interval=5000};
 readonly HttpClient http=new(){Timeout=TimeSpan.FromSeconds(2)};
 string LastHealth="Not checked";
 bool SetupDone=>File.Exists(Path.Combine(dir,"setup-complete.marker"));
 TextBox? hostnameBox;
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
  menu.Items.Add("Exit manager",null,(_,_)=>{Stop();cancel.Cancel();tray.Visible=false;ExitThread();});
  tray.ContextMenuStrip=menu;
  tray.DoubleClick+=(_,_)=>OpenSettings();
  _=Task.Run(()=>PipeLoop(cancel.Token));
  monitor.Tick+=async (_,_)=>await ProbeHealth();
  monitor.Start();
  if(SetupDone){Start();}else{OpenSettings();}
  _=ProbeHealth();
 }
 bool Running=>host is {HasExited:false};
 string Status=>Running?$"Host process running (PID {host!.Id}); health: {LastHealth}":"Host stopped";
 void RefreshStatus(){if(statusLabel is {IsDisposed:false})statusLabel.Text=Status;tray.Text=Running?"HomeMCP host process running":"HomeMCP stopped";}
 string ComponentReport(){
  var lines=new System.Collections.Generic.List<string>();
  lines.Add("Node runtime: "+(File.Exists(Path.Combine(app,"runtime","node.exe"))?"Installed":"MISSING"));
  lines.Add("JobRunner: "+(File.Exists(Path.Combine(app,"runtime","HomeMCP.JobRunner.exe"))?"Installed":"MISSING"));
  lines.Add("PowerShell: "+(File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell","v1.0","powershell.exe"))?"Available":"MISSING"));
  lines.Add("Playwright worker: "+(File.Exists(Path.Combine(app,"workers","playwright","cli.mjs"))?"Installed":"MISSING"));
  lines.Add("Desktop worker: "+(File.Exists(Path.Combine(app,"workers","windows-mcp.exe"))?"Installed":"MISSING"));
  lines.Add("Host configuration: "+(File.Exists(ConfigPath)?"Created":"Not created (generated on start)"));
  lines.Add("Network: "+(ReadState()["remoteEnabled"]?.GetValue<bool>()==true?"Remote requested":"Local only (safe default)"));
  lines.Add("Host health: "+LastHealth);
  return string.Join(Environment.NewLine,lines);
 }
 bool RequirementsOK()=>File.Exists(Path.Combine(app,"runtime","node.exe"))
  &&File.Exists(Path.Combine(app,"runtime","HomeMCP.JobRunner.exe"))
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
   var script=Path.Combine(app,"scripts","launch-installed.ps1");
   if(!File.Exists(script))throw new FileNotFoundException("HomeMCP start script missing",script);
   var runner=Path.Combine(app,"runtime","HomeMCP.JobRunner.exe");
   if(!File.Exists(runner))throw new FileNotFoundException("HomeMCP JobRunner missing",runner);
   var powershell=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell","v1.0","powershell.exe");
   if(!File.Exists(powershell))throw new FileNotFoundException("Windows PowerShell missing",powershell);
   host=Process.Start(new ProcessStartInfo(runner){
    UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=app,
    Arguments="--parent "+Environment.ProcessId+" -- \""+powershell+"\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \""+script+"\"",
   });
   if(host==null)throw new InvalidOperationException("Failed to spawn HomeMCP host");
   host.EnableRaisingEvents=true;
   host.Exited+=(_,_)=>{try{if(settings is {IsHandleCreated:true})settings.BeginInvoke((Action)RefreshStatus);}catch{}};
  } catch(Exception ex){MessageBox.Show(ex.Message,"HomeMCP start failed",MessageBoxButtons.OK,MessageBoxIcon.Error);}
  RefreshStatus();
 }
 void Stop(){
  try{
   if(Running){host!.Kill(entireProcessTree:true);host.WaitForExit(5000);}
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
  var input=hostnameBox.Text.Trim();
  if(input.Length>0&&!Uri.TryCreate(input,UriKind.Absolute,out _)){
   MessageBox.Show("Use an HTTPS URL, e.g. https://mcp.example.com");return;
  }
  if(input.Length>0 && (!input.StartsWith("https://",StringComparison.OrdinalIgnoreCase)||new Uri(input).Host.Length==0)){
   MessageBox.Show("Only HTTPS hostnames are accepted");return;
  }
  var obj=ReadState();
  obj["hostname"]=input.Length==0?"":new Uri(input).Host;
  obj["url"]=input;
  obj["mode"]=input.Length==0?"local":"external";
  obj["remoteEnabled"]=false; // never enable a tunnel just by typing a hostname
  File.WriteAllText(StatePath,obj.ToJsonString(new JsonSerializerOptions{WriteIndented=true}));
  MessageBox.Show("Saved locally. Remote access remains disabled until auth and tunnel validation.","HomeMCP");
 }
 void LaunchNetworkWizard(){
  try{
   Process.Start(new ProcessStartInfo("powershell.exe"){
    UseShellExecute=true,Arguments="-NoProfile -ExecutionPolicy Bypass -File \""+Path.Combine(app,"scripts","network-setup.ps1")+"\" -Force"
   });
  }catch(Exception ex){MessageBox.Show(ex.Message,"Network setup");}
 }
 void OpenSettings(){
  if(settings is {IsDisposed:false}){settings.Activate();return;}
  var form=new Form{Text=SetupDone?"HomeMCP Settings and Health":"HomeMCP First-run Setup",Width=630,Height=640,StartPosition=FormStartPosition.CenterScreen,MinimumSize=new Size(600,600)};
  settings=form;
  var layout=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=1,RowCount=9,Padding=new Padding(18),AutoScroll=true};
  layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,36));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,48));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,25));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,180));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,45));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,28));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,38));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,65));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,48));
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
  layout.Controls.Add(new Label{Text="Optional external HTTPS URL (record only; does NOT enable remote access)",AutoSize=true});
  hostnameBox=new TextBox{Dock=DockStyle.Fill,Text=ReadState()["url"]?.GetValue<string>()??""};layout.Controls.Add(hostnameBox);
  var network=new FlowLayoutPanel{Dock=DockStyle.Fill};
  var save=new Button{Text="Save URL",AutoSize=true};save.Click+=(_,_)=>SaveHostname();
  var cloud=new Button{Text="Advanced tunnel setup",AutoSize=true};cloud.Click+=(_,_)=>LaunchNetworkWizard();
  network.Controls.AddRange([save,cloud]);layout.Controls.Add(network);
  var foot=new FlowLayoutPanel{Dock=DockStyle.Fill};
  var finish=new Button{Text=SetupDone?"Recheck and start":"Finish setup and start",Width=210,Height=34};
  finish.Click+=(_,_)=>FinishSetup();foot.Controls.Add(finish);
  foot.Controls.Add(new Label{Text="Remote access remains OFF until secure setup is implemented.",AutoSize=true});
  layout.Controls.Add(foot);
  form.Controls.Add(layout);
  form.FormClosed+=(_,_)=>{statusLabel=null;componentsLabel=null;hostnameBox=null;settings=null;};
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
