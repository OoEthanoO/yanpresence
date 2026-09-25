#if VER != 0x06070300
  #error Use the pinned Inno Setup 6.7.3 compiler from scripts/build-windows.ps1
#endif
#ifndef AppVersion
  #error AppVersion must be supplied by scripts/build-windows.ps1
#endif
#ifndef PayloadDir
  #error PayloadDir must be supplied by scripts/build-windows.ps1
#endif
#ifndef OutputDir
  #error OutputDir must be supplied by scripts/build-windows.ps1
#endif
#ifndef ApplicationName
  #define ApplicationName "yanpresence"
#endif
#ifndef ApplicationId
  #define ApplicationId "{{94D746F4-038E-44E9-BB15-9BB13A0119AE}"
#endif

[Setup]
AppId={#ApplicationId}
AppName={#ApplicationName}
AppVersion={#AppVersion}
AppPublisher=Ethan Xu
AppPublisherURL=https://github.com/OoEthanoO/yanpresence
AppSupportURL=https://github.com/OoEthanoO/yanpresence/issues
AppUpdatesURL=https://github.com/OoEthanoO/yanpresence/releases
DefaultDirName={localappdata}\Programs\{#ApplicationName}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableWelcomePage=yes
DisableReadyPage=yes
UninstallDisplayIcon={app}\assets\yanpresence.ico
SetupIconFile={#PayloadDir}\assets\yanpresence.ico
OutputDir={#OutputDir}
OutputBaseFilename={#ApplicationName}-{#AppVersion}-windows-x64-setup
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
VersionInfoDescription={#ApplicationName} installer
VersionInfoVersion={#AppVersion}

[Tasks]
Name: "startup"; Description: "Start {#ApplicationName} when I sign in"; Flags: checkedonce

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#PayloadDir}\windows\stop-installed.ps1"; Flags: dontcopy

[InstallDelete]
Type: files; Name: "{userstartup}\{#ApplicationName}.lnk"; Tasks: not startup

[Icons]
Name: "{userprograms}\{#ApplicationName}"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\windows\yanpresence-launch.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\yanpresence.ico"; Comment: "Apple Music and Apple TV presence for Discord"; Flags: runminimized
Name: "{userstartup}\{#ApplicationName}"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\windows\yanpresence-launch.ps1"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\yanpresence.ico"; Tasks: startup; Flags: runminimized

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\windows\yanpresence-launch.ps1"""; WorkingDir: "{app}"; Description: "Launch {#ApplicationName}"; Flags: postinstall nowait runhidden skipifsilent

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\windows\stop-installed.ps1"" -InstallRoot ""{app}"""; Flags: runhidden waituntilterminated; RunOnceId: "StopInstalledYanpresence"

; No AppData delete rules: uninstall only removes the files Setup installed.
; User configuration, logs, and artwork caches remain available on reinstall.
[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
begin
  Result := '';
  ExtractTemporaryFile('stop-installed.ps1');
  if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\stop-installed.ps1') + '" -InstallRoot "' +
    ExpandConstant('{app}') + '"', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then
    Result := 'Could not close the previous installation. Quit yanpresence and try again.'
  else if ExitCode <> 0 then
    Result := 'Could not close the previous installation. Quit yanpresence and try again.';
end;
