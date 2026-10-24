using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Windows.Forms;

namespace HomeMCP.Manager;
sealed partial class TrayContext {
 void OpenUpdates(){using var window=new UpdateForm(app,dir);window.ShowDialog(settings);}
}
sealed class UpdateForm : Form {
 readonly string app,root;
 readonly TextBox candidate=new(){Dock=DockStyle.Fill},rollback=new(){Dock=DockStyle.Fill},feed=new(){Dock=DockStyle.Fill},signer=new(){Dock=DockStyle.Fill};
 readonly Label status=new(){AutoSize=true,MaximumSize=new System.Drawing.Size(640,0)};
 readonly CheckBox automatic=new(){Text="Automatically install daily after preflight passes",AutoSize=true};
 readonly Button localInstall=new(){Text="Validate and install local MSI…",AutoSize=true};
 readonly Button feedInstall=new(){Text="Validate and install from feed…",AutoSize=true};
 readonly System.Windows.Forms.Timer poll=new(){Interval=1000};
 string job="";
 public UpdateForm(string appPath,string dataPath){
  app=appPath;root=dataPath;Text="Update HomeMCP";Width=760;Height=620;MinimumSize=new System.Drawing.Size(650,560);AutoScaleMode=AutoScaleMode.Dpi;StartPosition=FormStartPosition.CenterParent;
  var layout=new TableLayoutPanel{Dock=DockStyle.Fill,Padding=new Padding(22),ColumnCount=1,RowCount=1,AutoScroll=true};
  layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
  void Add(Control c){layout.RowCount++;layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));layout.Controls.Add(c,0,layout.RowCount-1);}
  Add(new Label{Text="Update HomeMCP",AutoSize=true,Font=new System.Drawing.Font("Segoe UI",17,System.Drawing.FontStyle.Bold)});
  Add(new Label{Text="Keep the current version running until the candidate and rollback packages pass validation.",AutoSize=true,MaximumSize=new System.Drawing.Size(640,0)});
  Add(new Label{Text="Local candidate MSI",AutoSize=true});Add(candidate);
  var choose=new Button{Text="Choose local build…",AutoSize=true};choose.Click+=(_,_)=>Choose(candidate);Add(choose);
  Add(new Label{Text="Complete MSI of the currently installed version (required on the first update)",AutoSize=true});Add(rollback);
  var old=new Button{Text="Choose rollback installer…",AutoSize=true};old.Click+=(_,_)=>Choose(rollback);Add(old);
  localInstall.Click+=async (_,_)=>await Install(true);Add(localInstall);
  Add(new Label{Text="HTTPS update feed URL",AutoSize=true});Add(feed);
  Add(new Label{Text="Pinned Authenticode publisher certificate thumbprint",AutoSize=true});Add(signer);
  Add(automatic);
  var save=new Button{Text="Save daily update settings",AutoSize=true};save.Click+=async (_,_)=>await Configure();Add(save);
  feedInstall.Click+=async (_,_)=>await Install(false);Add(feedInstall);
  Add(new Label{Text="Local builds must be trusted. Remote updates require SHA-256 and the pinned publisher. Failed post-switch health checks trigger rollback; recovery problems are shown here.",AutoSize=true,MaximumSize=new System.Drawing.Size(640,0)});
  Add(status);
  var logs=new Button{Text="Open update logs",AutoSize=true};logs.Click+=(_,_)=>{var path=String.IsNullOrEmpty(job)?Path.Combine(root,"updates"):job;Directory.CreateDirectory(path);Process.Start(new ProcessStartInfo(path){UseShellExecute=true});};Add(logs);
  Controls.Add(layout);
  try{var config=JsonNode.Parse(File.ReadAllText(Path.Combine(root,"update-source.json")));feed.Text=config?["feedUrl"]?.ToString()??"";signer.Text=config?["signerThumbprint"]?.ToString()??"";automatic.Checked=config?["automaticInstall"]?.GetValue<bool>()??false;}catch{}
  poll.Tick+=(_,_)=>RefreshUpdateStatus();poll.Start();FormClosed+=(_,_)=>poll.Dispose();RefreshUpdateStatus();
 }
 void Choose(TextBox target){using var picker=new OpenFileDialog{Filter="Windows Installer (*.msi)|*.msi",CheckFileExists=true};if(picker.ShowDialog(this)==DialogResult.OK)target.Text=picker.FileName;}
 async Task<string> Hash(string path){return await Task.Run(()=>{using var stream=File.OpenRead(path);return Convert.ToHexString(SHA256.HashData(stream));});}
 async Task Install(bool local){
  if(MessageBox.Show(this,"Validate and install this trusted build? The updater will stop HomeMCP only after preflight succeeds, then check live health and roll back on failure.","HomeMCP update",MessageBoxButtons.OKCancel)!=DialogResult.OK)return;
  localInstall.Enabled=feedInstall.Enabled=false;
  try{
   var args=new List<string>{"-Mode","Install"};
   if(local){args.AddRange(new[]{"-LocalPackage",candidate.Text,"-Sha256",await Hash(candidate.Text)});}
   else {args.AddRange(new[]{"-FeedUrl",feed.Text,"-TrustedSignerThumbprint",signer.Text});}
   if(!String.IsNullOrWhiteSpace(rollback.Text)){args.AddRange(new[]{"-RollbackPackage",rollback.Text,"-RollbackSha256",await Hash(rollback.Text)});}
   status.Text=await Run("update.ps1",args);RefreshUpdateStatus();
  }catch(Exception e){status.Text=e.Message;localInstall.Enabled=feedInstall.Enabled=true;}
 }
 async Task Configure(){try{var args=new List<string>{"-FeedUrl",feed.Text,"-SignerThumbprint",signer.Text};if(automatic.Checked)args.Add("-InstallImmediately");status.Text=await Run("configure-updater.ps1",args);}catch(Exception e){status.Text=e.Message;}}
 async Task<string> Run(string script,List<string> args){
  return await Task.Run(()=>{
   var start=new ProcessStartInfo(Path.Combine(Environment.SystemDirectory,"WindowsPowerShell","v1.0","powershell.exe")){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
   foreach(var arg in new[]{"-NoProfile","-ExecutionPolicy","Bypass","-File",Path.Combine(app,"scripts",script)})start.ArgumentList.Add(arg);
   foreach(var arg in args)start.ArgumentList.Add(arg);
   using var p=Process.Start(start)??throw new Exception("Cannot start updater");
   var output=p.StandardOutput.ReadToEndAsync();var error=p.StandardError.ReadToEndAsync();p.WaitForExit();Task.WaitAll(output,error);
   if(p.ExitCode!=0)throw new Exception(error.Result+output.Result);return output.Result;
  });
 }
 void RefreshUpdateStatus(){
  try{
   var latest=JsonNode.Parse(File.ReadAllText(Path.Combine(root,"updates","latest.json")));job=latest?["job"]?.ToString()??"";
   var value=JsonNode.Parse(File.ReadAllText(Path.Combine(job,"status.json")));var phase=value?["phase"]?.ToString()??"";
   status.Text=phase+": "+value?["detail"]?.ToString();
   bool done=new[]{"complete","failed","rolled_back","recovery_required"}.Contains(phase);
   localInstall.Enabled=feedInstall.Enabled=done;
  }catch{}
 }
}
