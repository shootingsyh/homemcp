using System.Diagnostics;
using System.Drawing;
using System.Text.Json.Nodes;
using System.Windows.Forms;

namespace HomeMCP.Manager;

sealed partial class TrayContext {
 string? McpEndpoint(){
  try{
   var origin=JsonNode.Parse(File.ReadAllText(ConfigPath))?["publicUrl"]?.GetValue<string>()??"";
   if(!Uri.TryCreate(origin,UriKind.Absolute,out var uri)||uri.Scheme!="https"||uri.UserInfo.Length>0||uri.AbsolutePath!="/"||uri.Query.Length>0||uri.Fragment.Length>0)return null;
   return uri.GetLeftPart(UriPartial.Authority)+"/mcp";
  }catch{return null;}
 }
 void AddConnectionSection(FlowLayoutPanel content){
  var endpoint=McpEndpoint();
  content.Controls.Add(new Label{Text="Your MCP endpoint",AutoSize=true,Font=new Font("Segoe UI",11,FontStyle.Bold)});
  var address=new TextBox{Text=endpoint??"Complete tunnel setup to get your MCP URL.",ReadOnly=true,Width=620,AccessibleName="MCP endpoint"};
  content.Controls.Add(address);
  var copy=new Button{Text="Copy URL",AutoSize=true,Enabled=endpoint!=null};
  copy.Click+=(_,_)=>{if(endpoint!=null)Clipboard.SetText(endpoint);};content.Controls.Add(copy);
  content.Controls.Add(new Label{Text="Connect your AI client",AutoSize=true,Font=new Font("Segoe UI",11,FontStyle.Bold)});
  content.Controls.Add(new Label{Text="ChatGPT: follow the OAuth connection steps. Muse: copy a ready-to-use setup prompt.",AutoSize=true,MaximumSize=new Size(620,0)});
  var actions=new FlowLayoutPanel{Width=630,AutoSize=true,WrapContents=true};
  var chatgpt=new Button{Text="Connect ChatGPT · Step by step",AutoSize=true,Height=38};
  var muse=new Button{Text="Connect Muse · Copy prompt",AutoSize=true,Height=38};
  chatgpt.Click+=(_,_)=>OpenConnectionGuide(false);muse.Click+=(_,_)=>OpenConnectionGuide(true);
  actions.Controls.Add(chatgpt);actions.Controls.Add(muse);content.Controls.Add(actions);
  content.SizeChanged+=(_,_)=>{
   int width=Math.Max(200,content.ClientSize.Width-content.Padding.Horizontal-SystemInformation.VerticalScrollBarWidth-8);
   address.Width=width;actions.Width=width;
  };
 }
 void OpenConnectionGuide(bool muse){
  using var form=new ConnectionGuideForm(muse,McpEndpoint());
  form.ShowDialog(settings);
 }
}

sealed class ConnectionGuideForm : Form {
 internal static string MusePrompt(string endpoint)=>$"""
Create a remote MCP connection named HomeMCP for my own computer.

MCP endpoint: {endpoint}
This is the HomeMCP Host running on my own computer. The public tunnel is only a relay, not the MCP server or OAuth provider.
Transport: Streamable HTTP (HTTPS).
Authentication: OAuth 2.0. Complete HomeMCP's browser authorization flow. Do not select No authentication, use a local MCP subprocess, or paste a shared Bearer token.

Human-in-the-loop approval is required for sensitive operations:
- Show the exact action and approval link when HomeMCP returns a pending approval.
- I will approve or reject using my registered Passkey. Never approve for me or bypass security.
- Follow approval_status / approval_resume / approval_result for the SAME pending operation. A pending approval is not permission to execute.
- Stop on denial or expiration. Check existing operations before retrying after a timeout; do not duplicate changes.
- ChatGPT/Muse permission dialogs are separate from HomeMCP Passkey approval.

Do not store tokens in chat history or disable authentication. Test a harmless read-only tool and report whether the connection succeeds. If you cannot configure the connection, give me the exact manual steps.
""";
 const string ChatGPTSteps="1. Open ChatGPT and go to Plugins.\r\n\r\n2. Select Add → Add custom MCP server. Name it HomeMCP and paste your MCP URL.\r\n\r\n3. Select OAuth. Finish the HomeMCP browser sign-in and authorization flow.\r\n\r\n4. Create and install the plugin, open Work, and use @HomeMCP to test a read-only tool.\r\n\r\nAvailable options depend on your ChatGPT plan and workspace permissions.";
 internal ConnectionGuideForm(bool muse,string? endpoint){
  Text=muse?"Connect Muse":"Connect ChatGPT";
  Width=700;Height=600;MinimumSize=new Size(560,460);AutoScaleMode=AutoScaleMode.Dpi;StartPosition=FormStartPosition.CenterParent;
  var layout=new TableLayoutPanel{Dock=DockStyle.Fill,Padding=new Padding(24),ColumnCount=1,RowCount=5};
  layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
  layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
  layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));layout.RowStyles.Add(new RowStyle(SizeType.Percent,100));layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
  layout.Controls.Add(new Label{Text=Text,AutoSize=true,Font=new Font("Segoe UI",16,FontStyle.Bold)},0,0);
  var address=new TextBox{ReadOnly=true,Text=endpoint??"Complete tunnel setup first.",Dock=DockStyle.Fill,AccessibleName="MCP endpoint"};layout.Controls.Add(address,0,1);
  var copy=new Button{Text="Copy MCP URL",AutoSize=true,Enabled=endpoint!=null};copy.Click+=(_,_)=>{if(endpoint!=null)Clipboard.SetText(endpoint);};layout.Controls.Add(copy,0,2);
  var body=new TextBox{ReadOnly=true,Multiline=true,ScrollBars=ScrollBars.Vertical,Dock=DockStyle.Fill,Text=muse?MusePrompt(endpoint??"<your HomeMCP HTTPS endpoint>/mcp"):ChatGPTSteps,AccessibleName=muse?"Muse setup prompt":"ChatGPT connection steps"};layout.Controls.Add(body,0,3);
  var footer=new FlowLayoutPanel{Dock=DockStyle.Fill,AutoSize=true};
  var action=new Button{Text=muse?"Copy Muse setup prompt":"Open ChatGPT",AutoSize=true,Enabled=!muse||endpoint!=null};
  action.Click+=(_,_)=>{if(muse&&endpoint!=null)Clipboard.SetText(MusePrompt(endpoint));else if(!muse)Process.Start(new ProcessStartInfo("https://chatgpt.com"){UseShellExecute=true});};
  var done=new Button{Text="Done",AutoSize=true};done.Click+=(_,_)=>Close();footer.Controls.Add(action);footer.Controls.Add(done);layout.Controls.Add(footer,0,4);Controls.Add(layout);
 }
}
