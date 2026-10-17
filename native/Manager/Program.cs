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
 readonly string app=AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
 readonly string dir=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"HomeMCP");
 readonly NotifyIcon tray;
 Process? host;
 CancellationTokenSource cancel=new();
 Form? settings;
 Label? statusLabel;
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
  Start();
 }
 bool Running=>host is {HasExited:false};
 string Status=>Running?$"Running (PID {host!.Id})":"Stopped";
 void RefreshStatus(){if(statusLabel is {IsDisposed:false})statusLabel.Text=Status;tray.Text=Running?"HomeMCP running":"HomeMCP stopped";}
 void Start(){
  if(Running)return;
  try{
   var script=Path.Combine(app,"scripts","launch-installed.ps1");
   if(!File.Exists(script))throw new FileNotFoundException("HomeMCP start script missing",script);
   host=Process.Start(new ProcessStartInfo("powershell.exe"){
    UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=app,
    Arguments="-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \""+script+"\"",
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
  finally{host?.Dispose();host=null;}
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
 void OpenSettings(){
  if(settings is {IsDisposed:false}){settings.Activate();return;}
  var form=new Form{Text="HomeMCP Settings",Width=490,Height=360,StartPosition=FormStartPosition.CenterScreen,FormBorderStyle=FormBorderStyle.FixedDialog,MaximizeBox=false,MinimizeBox=false};
  settings=form;
  var layout=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=1,RowCount=8,Padding=new Padding(18)};
  layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,35));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,44));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,30));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,38));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,44));
  layout.RowStyles.Add(new RowStyle(SizeType.Absolute,44));
  statusLabel=new Label{Text=Status,AutoSize=true,Font=new Font("Segoe UI",12,FontStyle.Bold)};
  layout.Controls.Add(statusLabel);
  var actions=new FlowLayoutPanel{Dock=DockStyle.Fill};
  var start=new Button{Text="Start",Width=90};start.Click+=(_,_)=>Start();
  var stop=new Button{Text="Stop",Width=90};stop.Click+=(_,_)=>Stop();
  var restart=new Button{Text="Restart",Width=90};restart.Click+=(_,_)=>{Stop();Start();};
  actions.Controls.AddRange([start,stop,restart]);layout.Controls.Add(actions);
  layout.Controls.Add(new Label{Text="External HTTPS URL (optional)",AutoSize=true});
  hostnameBox=new TextBox{Width=420,Text=ReadState()["url"]?.GetValue<string>()??""};layout.Controls.Add(hostnameBox);
  var save=new Button{Text="Save address (does not expose service)",AutoSize=true};save.Click+=(_,_)=>SaveHostname();layout.Controls.Add(save);
  var net=new Button{Text="Configure Cloudflare / Other Tunnel",AutoSize=true};
  net.Click+=(_,_)=>{
   try{Process.Start(new ProcessStartInfo("powershell.exe"){UseShellExecute=true,Arguments="-NoProfile -ExecutionPolicy Bypass -File \""+Path.Combine(app,"scripts","network-setup.ps1")+"\" -Force"});}
   catch(Exception ex){MessageBox.Show(ex.Message);}
  };
  layout.Controls.Add(net);
  layout.Controls.Add(new Label{Text="Management is local-only. Updating an address never changes public DNS.",AutoSize=true});
  form.Controls.Add(layout);
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
    if(settings is {IsHandleCreated:true})settings.BeginInvoke((Action)Execute);
    else {
      // The WinForms synchronization context is backed by the tray message loop.
      formDispatcher.BeginInvoke((Action)Execute);
    }
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
