function Copy-HomeMCPDependencies {
 param([Parameter(Mandatory)][string]$Source,[Parameter(Mandatory)][string]$Destination)
 $sourcePath=[IO.Path]::GetFullPath($Source)
 $destinationPath=[IO.Path]::GetFullPath($Destination)
 if($sourcePath.TrimEnd('\') -eq $destinationPath.TrimEnd('\')){throw 'Dependency source and destination must differ'}
 if(!(Test-Path -LiteralPath $sourcePath -PathType Container)){throw 'Dependency source missing'}
 if(Test-Path -LiteralPath (Join-Path $sourcePath 'node_modules')){throw 'Unexpected node_modules/node_modules in dependency source; run a clean npm ci'}
 # Copy-Item nests the source inside an existing destination on repeat builds.
 # Replace this dedicated build directory instead of merging different module trees.
 if(Test-Path -LiteralPath $destinationPath){Remove-Item -LiteralPath $destinationPath -Recurse -Force}
 Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Recurse -Force
 if(Test-Path -LiteralPath (Join-Path $destinationPath 'node_modules')){throw 'Nested dependency root detected in payload'}
}
