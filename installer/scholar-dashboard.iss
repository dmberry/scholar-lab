; Inno Setup script — builds a Windows installer (Setup.exe) from the
; PyInstaller onedir output in dist\scholar-dashboard\.
;
; Compile (after build.ps1 has produced dist\scholar-dashboard\):
;   iscc /DMyAppVersion=0.2.57 installer\scholar-dashboard.iss
;
; build.ps1 invokes this automatically if iscc.exe is on PATH.

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif
#define MyAppName "Scholar Dashboard"
#define MyAppExeName "scholar-dashboard.exe"

[Setup]
AppId={{A6F2B9C4-7E31-4D8A-9F0B-SCHOLARDASH01}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=David M. Berry
AppPublisherURL=https://github.com/dmberry/scholar-lab
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
; Per-user install so no admin rights are needed.
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=Scholar-Dashboard-{#MyAppVersion}-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional icons:"

[Files]
; Ship the whole PyInstaller onedir output.
Source: "..\dist\scholar-dashboard\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent
