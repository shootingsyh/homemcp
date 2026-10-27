using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text.Json.Nodes;

namespace HomeMCP.Manager;

sealed partial class TrayContext {
 bool managedSetupBusy;
 Form? managedSetupForm;
 async Task<JsonObject> ManagedCommand(string action,string origin="",string plan="monthly"){
  var info=new ProcessStartInfo(Path.Combine(app,"runtime","node.exe")){
   UseShellExecute=false,CreateNoWindow=true,WorkingDirectory=app,
   RedirectStandardOutput=true,RedirectStandardError=true
  };
  info.Environment["HOMEMCP_HOME"]=dir;
  foreach(var arg in new[]{Path.Combine(app,"scripts","windows-managed-setup.mjs"),action,origin,plan})info.ArgumentList.Add(arg);
  using var process=Process.Start(info)??throw new Exception("Managed setup could not start.");
  var output=process.StandardOutput.ReadToEndAsync();
  var error=process.StandardError.ReadToEndAsync();
  using var timeout=new CancellationTokenSource(TimeSpan.FromMinutes(11));
  try{await process.WaitForExitAsync(timeout.Token);}catch(OperationCanceledException){try{process.Kill(entireProcessTree:true);}catch{}throw new Exception("Managed setup timed out. No payment was retried.");}
  var json=JsonNode.Parse((await output).Trim()) as JsonObject;
  await error; // Do not log private stdout, checkout URLs, or helper diagnostics.
  if(process.ExitCode!=0||json?["ok"]?.GetValue<bool>()!=true)throw new Exception(json?["error"]?.GetValue<string>()??"Managed setup failed.");
  return json;
 }
 async Task VerifyManagedDomain(string origin){
  var config=JsonNode.Parse(await File.ReadAllTextAsync(ConfigPath));
  var port=config?["port"]?.GetValue<int>()??0;
  var admin=config?["security"]?["adminToken"]?.GetValue<string>()??"";
  if(port<1||String.IsNullOrEmpty(admin))throw new Exception("Local Host is not configured.");
  using var handler=new HttpClientHandler{AllowAutoRedirect=false};
  using var remote=new HttpClient(handler){Timeout=TimeSpan.FromSeconds(5)};
  for(int attempt=0;attempt<30;attempt++){
   try{
    using var request=new HttpRequestMessage(HttpMethod.Post,"http://127.0.0.1:"+port+"/admin/tunnel-check");
    request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",admin);
    using var localResponse=await http.SendAsync(request);
    localResponse.EnsureSuccessStatusCode();
    var challenge=JsonNode.Parse(await localResponse.Content.ReadAsStringAsync());
    var route=challenge?["path"]?.GetValue<string>()??throw new Exception("Missing tunnel challenge.");
    var nonce=challenge?["nonce"]?.GetValue<string>()??"";
    using var response=await remote.GetAsync(origin+route);
    if(response.IsSuccessStatusCode){
     var proof=JsonNode.Parse(await response.Content.ReadAsStringAsync());
     using var discovery=await remote.GetAsync(origin+"/.well-known/oauth-authorization-server");
     var metadata=JsonNode.Parse(await discovery.Content.ReadAsStringAsync());
     if(proof?["nonce"]?.GetValue<string>()==nonce&&discovery.IsSuccessStatusCode&&metadata?["issuer"]?.GetValue<string>()==origin)return;
    }
   }catch{}
   await Task.Delay(1500);
  }
  throw new Exception("The public tunnel did not verify. Restoring the previous domain.");
 }
 void OpenManagedSetup(Action<string>? connected=null,string? requestedOrigin=null){
  if(managedSetupForm is {IsDisposed:false}){managedSetupForm.Activate();return;}
  var form=new Form{Text="HomeMCP · Managed domain",Width=650,Height=430,MinimumSize=new Size(620,420),StartPosition=FormStartPosition.CenterScreen};
  managedSetupForm=form;
  var body=new FlowLayoutPanel{Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoScroll=true,Padding=new Padding(24)};
  body.Controls.Add(new Label{Text="Choose your HomeMCP domain",AutoSize=true,Font=new Font("Segoe UI",16,FontStyle.Bold)});
  body.Controls.Add(new Label{Text="Register a new managed domain or reconnect one you already set up.",Width=560,Height=35});
  string current="";
  try{current=JsonNode.Parse(File.ReadAllText(ConfigPath))?["publicUrl"]?.GetValue<string>()??"";}catch{}
  if(requestedOrigin!=null)current=requestedOrigin;
  var username=new TextBox{Width=250,AccessibleName="Tunnel username"};
  if(Uri.TryCreate(current,UriKind.Absolute,out var currentUri)&&currentUri.Host.EndsWith(".tunnel.homemcp.si",StringComparison.Ordinal))username.Text=currentUri.Host.Split('.')[0];
  var domainRow=new FlowLayoutPanel{Width=560,Height=42};
  domainRow.Controls.Add(username);domainRow.Controls.Add(new Label{Text=".tunnel.homemcp.si",AutoSize=true,Padding=new Padding(0,5,0,0)});body.Controls.Add(domainRow);
  var plan=new ComboBox{Width=330,DropDownStyle=ComboBoxStyle.DropDownList,AccessibleName="Subscription plan"};
  plan.Items.AddRange(["Monthly — $0.99/month + applicable tax","Annual — $9.99/year + applicable tax"]);plan.SelectedIndex=0;body.Controls.Add(plan);
  body.Controls.Add(new Label{Text="New subscriptions are completed in Stripe Checkout. Existing domains do not create another subscription. Your existing devices and Passkeys are retained; they work on the domain where they were registered.",Width=560,Height=75});
  var apply=new Button{Text="Register / reconnect domain",Width=260,Height=36};body.Controls.Add(apply);
  var state=new Label{Text="Your current connection stays active until the new domain is ready.",Width=565,Height=65};body.Controls.Add(state);
  form.Controls.Add(body);
  var poll=new System.Windows.Forms.Timer{Interval=3000};
  string origin="",selectedPlan="monthly";bool polling=false,activating=false;DateTime deadline=DateTime.MinValue;
  void Unlock(){managedSetupBusy=false;apply.Enabled=true;username.Enabled=true;plan.Enabled=true;}
  async Task Fail(Exception error){
   poll.Stop();state.Text="Stopped: "+error.Message+" No payment was retried.";
   Unlock();await Task.CompletedTask;
  }
  async Task Connect(){
   poll.Stop();activating=true;
   bool switched=false;
   try{
    state.Text="Payment/account activated. Preparing this computer's TLS certificate…";
    await ManagedCommand("prepare",origin,selectedPlan);
    state.Text="Switching this HomeMCP to "+origin+"…";
    monitor.Stop();Stop();
    await ManagedCommand("activate",origin,selectedPlan);switched=true;
    Start();
    state.Text="Verifying the public tunnel and OAuth discovery…";
    await VerifyManagedDomain(origin);
    await ProbeHealth();
    state.Text="Connected: "+origin+"\r\nYour existing Passkey records have been preserved.";
    connected?.Invoke(origin);
    Unlock();
   }catch(Exception error){
    if(switched){
     try{Stop();await ManagedCommand("rollback");Start();}catch{state.Text="Switch failed; automatic restore also failed. Existing backups are retained. Check diagnostics.";Unlock();return;}
    }else if(!Running)Start();
    await Fail(error);
   }finally{activating=false;monitor.Start();}
  }
  async Task CheckClaim(){
   if(polling)return;polling=true;
   try{
    if(DateTime.UtcNow>deadline)throw new Exception("Payment wait expired. Reopen this domain to resume the same registration.");
    var result=await ManagedCommand("claim",origin,selectedPlan);
    if(result["claimed"]?.GetValue<bool>()==true)await Connect();
   }catch(Exception error){await Fail(error);}finally{polling=false;}
  }
  poll.Tick+=async (_,_)=>await CheckClaim();
  apply.Click+=async (_,_)=>{
   if(managedSetupBusy)return;
   var name=username.Text.Trim();
   if(!System.Text.RegularExpressions.Regex.IsMatch(name,@"^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$")){state.Text="Use a lowercase username with letters, digits, and internal hyphens.";return;}
   origin="https://"+name+".tunnel.homemcp.si";selectedPlan=plan.SelectedIndex==0?"monthly":"annual";
   if(MessageBox.Show("Set up "+origin+"?\n\nIf this is a new subscription, Stripe Checkout will show the exact price and tax before you pay. Payment is submitted only in the browser. Your existing Passkeys will be retained.","HomeMCP managed domain",MessageBoxButtons.OKCancel,MessageBoxIcon.Information)!=DialogResult.OK)return;
   managedSetupBusy=true;apply.Enabled=false;username.Enabled=false;plan.Enabled=false;
   try{
    if(!Running)Start();
    state.Text="Registering or resuming your domain…";
    var result=await ManagedCommand("begin",origin,selectedPlan);
    if(result["claimed"]?.GetValue<bool>()==true){await Connect();return;}
    var checkout=result["checkoutUrl"]?.GetValue<string>();
    if(!String.IsNullOrEmpty(checkout)){
     var checkoutUri=new Uri(checkout);
     if(checkoutUri.Scheme!="https"||(checkoutUri.Host!="checkout.stripe.com"&&checkoutUri.Host!="api.homemcp.si"))throw new Exception("Unexpected checkout address.");
     Process.Start(new ProcessStartInfo(checkout){UseShellExecute=true});
     state.Text="Finish payment in the browser. Waiting for activation; HomeMCP will connect automatically. Do not submit payment twice.";
    }else state.Text="Waiting for account activation…";
    deadline=DateTime.UtcNow.AddMinutes(10);poll.Start();await CheckClaim();
   }catch(Exception error){await Fail(error);}
  };
  form.FormClosing+=(_,e)=>{if(activating){e.Cancel=true;return;}poll.Stop();Unlock();};
  form.FormClosed+=(_,_)=>{poll.Dispose();managedSetupForm=null;};
  form.ShowDialog(settings);
 }

 void OpenDomainSettings(){
  var form=new Form{Text="HomeMCP · Change domain",Width=650,Height=360,StartPosition=FormStartPosition.CenterScreen};
  var body=new FlowLayoutPanel{Dock=DockStyle.Fill,FlowDirection=FlowDirection.TopDown,WrapContents=false,Padding=new Padding(24)};
  body.Controls.Add(new Label{Text="Change this computer's domain",AutoSize=true,Font=new Font("Segoe UI",16,FontStyle.Bold)});
  string current="";try{current=JsonNode.Parse(File.ReadAllText(ConfigPath))?["publicUrl"]?.GetValue<string>()??"";}catch{}
  var origin=new TextBox{Text=current,Width=560,AccessibleName="New public domain"};body.Controls.Add(origin);
  var byot=new RadioButton{Text="My own domain and tunnel",AutoSize=true};
  var managed=new RadioButton{Text="HomeMCP managed domain",AutoSize=true};
  managed.Checked=current.EndsWith(".tunnel.homemcp.si",StringComparison.OrdinalIgnoreCase);byot.Checked=!managed.Checked;
  body.Controls.Add(byot);body.Controls.Add(managed);
  body.Controls.Add(new Label{Text="Existing devices and Passkey records are kept. A different domain needs its own Passkey if you use approvals there. Switching back does not require registering the old devices again.",Width=560,Height=65});
  var apply=new Button{Text="Continue",Width=160,Height=35};body.Controls.Add(apply);
  var status=new Label{Width=560,Height=45};body.Controls.Add(status);form.Controls.Add(body);
  bool processing=false;
  apply.Click+=async (_,_)=>{
   if(processing)return;
   if(!Uri.TryCreate(origin.Text.Trim(),UriKind.Absolute,out var uri)||uri.Scheme!="https"||uri.Port!=443||uri.UserInfo!=""||uri.AbsolutePath!="/"||uri.Query!=""||uri.Fragment!=""){status.Text="Enter a bare HTTPS domain, for example https://mcp.example.com";return;}
   var target=uri.GetLeftPart(UriPartial.Authority);
   if(managed.Checked){
    if(!System.Text.RegularExpressions.Regex.IsMatch(uri.Host,@"^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?\.tunnel\.homemcp\.si$")){status.Text="A managed domain must use username.tunnel.homemcp.si";return;}
    form.Close();OpenManagedSetup(null,target);return;
   }
   processing=true;apply.Enabled=false;
   try{status.Text="Switching and verifying the new domain…";if(await BindExternalDomain(target)){processing=false;form.Close();}else status.Text="The new domain was not activated. Your previous configuration was retained.";}
   finally{processing=false;apply.Enabled=true;}
  };
  form.FormClosing+=(_,e)=>{if(processing)e.Cancel=true;};
  form.ShowDialog(settings);
 }

 async Task<bool> BindExternalDomain(string origin){
  if(managedSetupBusy)throw new Exception("Another domain change is in progress.");
  var uri=new Uri(origin);
  if(uri.Scheme!="https"||uri.Port!=443||uri.UserInfo!=""||uri.AbsolutePath!="/"||uri.Query!=""||uri.Fragment!="")throw new Exception("A bare HTTPS domain is required.");
  var previous=await File.ReadAllTextAsync(ConfigPath);
  var previousState=File.Exists(StatePath)?await File.ReadAllTextAsync(StatePath):null;
  var config=JsonNode.Parse(previous) as JsonObject??throw new Exception("Invalid Host configuration.");
  if(config["publicUrl"]?.GetValue<string>()==origin){await VerifyByotConnection();return true;}
  if(MessageBox.Show("Switch HomeMCP to "+origin+"?\n\nConfigure your own tunnel first. The connection will restart briefly. Existing devices, Passkeys, and OAuth records will be retained; old-domain Passkeys work again when you switch back. If verification fails, the previous configuration will be restored.","Change HomeMCP domain",MessageBoxButtons.OKCancel,MessageBoxIcon.Information)!=DialogResult.OK)return false;
  managedSetupBusy=true;monitor.Stop();
  try{
   var stamp=DateTime.UtcNow.ToString("yyyyMMddHHmmssfff");
   File.Copy(ConfigPath,ConfigPath+".before-domain-rebind-"+stamp+".bak");
   Stop();
   config["publicUrl"]=origin;config["connectionMode"]="byot";
   var security=config["security"] as JsonObject??new JsonObject();config["security"]=security;
   var domains=security["passkeyDomains"] as JsonObject??new JsonObject();security["passkeyDomains"]=domains;
   var dataDir=config["dataDir"]?.GetValue<string>()??Path.Combine(dir,"data");
   var previousRp=security["rpID"]?.GetValue<string>();
   if(!String.IsNullOrEmpty(previousRp))domains[previousRp]=security["passkeyDataDir"]?.GetValue<string>()??dataDir;
   var passkeyDir=domains[uri.Host]?.GetValue<string>()??Path.Combine(dataDir,"domains",uri.Host);
   domains[uri.Host]=passkeyDir;security["passkeyDataDir"]=passkeyDir;security["rpOrigin"]=origin;security["rpID"]=uri.Host;
   var oauth=config["oauth"] as JsonObject??new JsonObject();config["oauth"]=oauth;oauth["enabled"]=true;oauth.Remove("issuer");
   var tmp=ConfigPath+".rebind.tmp";await File.WriteAllTextAsync(tmp,config.ToJsonString());File.Move(tmp,ConfigPath,true);
   var state=ReadState();state["mode"]="external";state["hostname"]=uri.Host;state["url"]=origin;state["remoteEnabled"]=true;
   await File.WriteAllTextAsync(StatePath,state.ToJsonString());Start();
   await Task.Delay(1500);await VerifyByotConnection();await ProbeHealth();return true;
  }catch(Exception error){
   Stop();await File.WriteAllTextAsync(ConfigPath,previous);
   if(previousState!=null)await File.WriteAllTextAsync(StatePath,previousState);else if(File.Exists(StatePath))File.Delete(StatePath);
   Start();MessageBox.Show("Domain change failed: "+error.Message+"\nThe previous domain configuration was restored.","HomeMCP domain");return false;
  }finally{managedSetupBusy=false;monitor.Start();}
 }
}
