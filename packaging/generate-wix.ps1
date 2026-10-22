param([Parameter(Mandatory)][string]$Payload,[Parameter(Mandatory)][string]$Output)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Xml.Linq
function X([string]$value){return [System.Security.SecurityElement]::Escape($value)}
$files=Get-ChildItem $Payload -File -Recurse | Sort-Object FullName
$folderPaths=@('')
foreach($f in $files){
  $rel=$f.FullName.Substring($Payload.Length).TrimStart('\','/')
  $dir=Split-Path $rel -Parent
  while($dir -and $dir -notin $folderPaths){$folderPaths+= $dir; $dir=Split-Path $dir -Parent}
}
$folderPaths=@($folderPaths | Sort-Object {($_ -split '[\/]').Count})
$ids=@{''='INSTALLFOLDER'}
$n=0
$dirs=New-Object System.Collections.Generic.List[string]
foreach($dir in $folderPaths){
  if(!$dir){continue}
  $n++;$ids[$dir]="Dir$n"
  $parent=Split-Path $dir -Parent; if(!$parent){$parent=''}
  $name=Split-Path $dir -Leaf
  $dirs.Add("<Directory Id=`"$($ids[$dir])`" Name=`"$(X $name)`" />")
}
function FolderXml([string]$parent){
 $buffer=''
 foreach($dir in $folderPaths){if(!$dir){continue};$p=Split-Path $dir -Parent;if(!$p){$p=''};if($p -eq $parent){
   $name=Split-Path $dir -Leaf
   $buffer += "<Directory Id=`"$($ids[$dir])`" Name=`"$(X $name)`">"+(FolderXml $dir)+"</Directory>"
 }}
 return $buffer
}
$parts='';$i=0;$managerFileId=''
foreach($f in $files){
 $i++;$rel=$f.FullName.Substring($Payload.Length).TrimStart('\','/');$dir=Split-Path $rel -Parent; if(!$dir){$dir=''}
 $source=X $f.FullName
 if($rel -ieq "runtime\HomeMCP.Manager.exe"){$managerFileId="PayloadFile$i"}
 $parts+="<Component Id=`"Payload$i`" Directory=`"$($ids[$dir])`" Guid=`"*`"><File Id=`"PayloadFile$i`" Source=`"$source`" KeyPath=`"yes`" /></Component>"
}
if(!$managerFileId){throw "Manager exe missing from MSI payload"}
$xml=@"
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs">
  <Package Name="HomeMCP" Manufacturer="HomeMCP" Version="0.1.27" UpgradeCode="E9437E1E-90A8-4D3D-9870-6A591E159CE4" Scope="perUser">
    <MajorUpgrade DowngradeErrorMessage="A newer HomeMCP is already installed." />
    <MediaTemplate EmbedCab="yes" />
    <CustomAction Id="LaunchHomeMCP" FileRef="$managerFileId" ExeCommand="" Execute="immediate" Impersonate="yes" Return="asyncNoWait" />
    <InstallExecuteSequence><Custom Action="LaunchHomeMCP" After="InstallFinalize" Condition="NOT REMOVE AND UILevel &gt;= 3" /></InstallExecuteSequence>
    <StandardDirectory Id="LocalAppDataFolder">
      <Directory Id="HOMEFOLDER" Name="HomeMCP">
        <Directory Id="INSTALLFOLDER" Name="app">$(FolderXml '')</Directory>
      </Directory>
    </StandardDirectory>
    <Feature Id="MainFeature" Title="HomeMCP" Level="1"><ComponentGroupRef Id="PayloadGroup"/><ComponentRef Id="AutoRun"/></Feature>
  </Package>
  <Fragment><ComponentGroup Id="PayloadGroup">$parts</ComponentGroup></Fragment>
  <Fragment><Component Id="AutoRun" Directory="INSTALLFOLDER" Guid="*"><RegistryValue Root="HKCU" Key="Software\Microsoft\Windows\CurrentVersion\Run" Name="HomeMCP" Value="&quot;[INSTALLFOLDER]runtime\HomeMCP.Manager.exe&quot;" Type="string" KeyPath="yes" /></Component></Fragment>
</Wix>
"@
[System.IO.File]::WriteAllText($Output,$xml,[System.Text.UTF8Encoding]::new($false))
[xml]$validated=$xml
Write-Host "WiX manifest generated for $($files.Count) packaged files."
