using System.Diagnostics;
using System.Text.Json.Nodes;
using System.Windows.Forms;

namespace HomeMCP.Manager;
sealed partial class TrayContext {
 void AddDesktopTestSection(FlowLayoutPanel content, Form form, bool smoke) {
  content.Controls.Add(new Label{Text="Desktop access test",AutoSize=true,Font=new System.Drawing.Font("Segoe UI",11,System.Drawing.FontStyle.Bold)});
  var status=new Label{Text="Not tested. Checks an actual screenshot and desktop window reading.",AutoSize=true,MaximumSize=new System.Drawing.Size(640,0)};
  content.Controls.Add(status);
  var retry=new Button{Text="Test Desktop Again",AutoSize=true,MinimumSize=new System.Drawing.Size(180,32)};
  content.Controls.Add(retry);
  async Task Test(){
   if(!retry.Enabled)return;
   retry.Enabled=false;status.Text="Testing screenshot and window reading…";
   string text;
   try{
    var start=new ProcessStartInfo(Path.Combine(app,"runtime","node.exe")){
     UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true
    };
    start.ArgumentList.Add(Path.Combine(app,"scripts","windows-desktop-self-test.mjs"));
    start.ArgumentList.Add(ConfigPath);
    using var process=Process.Start(start)??throw new Exception("Desktop test could not start.");
    var output=process.StandardOutput.ReadToEndAsync();
    var errors=process.StandardError.ReadToEndAsync();
    using var deadline=new CancellationTokenSource(TimeSpan.FromSeconds(55));
    try{await process.WaitForExitAsync(deadline.Token);}
    catch(OperationCanceledException){
     // This process is only the probe, never the Host/worker or their children.
     try{process.Kill();}catch{}
     throw new Exception("Desktop test timed out. Check diagnostics before retrying.");
    }
    var raw=await output;await errors;
    if(process.ExitCode!=0)throw new Exception("Desktop test could not finish. Check diagnostics and retry.");
    var report=JsonNode.Parse(raw)??throw new Exception("Invalid desktop test report.");
    var ready=report["ready"]?.GetValue<bool>()==true;
    var lines=new List<string>{ready?"Desktop control is ready — both tests passed.":"Desktop access needs attention."};
    if(report["checks"] is not JsonArray checks)throw new Exception("Invalid desktop test report.");
    foreach(var check in checks){
     var name=check?["name"]?.ToString()=="screenshot"?"Screenshot":check?["name"]?.ToString()=="window"?"Window reading":"Local Host";
     lines.Add(name+": "+check?["state"]?.ToString()+". "+check?["detail"]?.ToString());
     if(check?["nextStep"] is JsonNode next)lines.Add(next.ToString());
    }
    text=string.Join(Environment.NewLine,lines);
   }catch(Exception ex){text=ex.Message;}
   if(!form.IsDisposed){status.Text=text;retry.Enabled=true;}
  }
  retry.Click+=async (_,_)=>await Test();
  if(!smoke)form.Shown+=async (_,_)=>await Test();
 }
}
