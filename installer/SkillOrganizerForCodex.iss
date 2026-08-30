#ifndef AppVersion
  #error AppVersion must be provided by the release build.
#endif
#ifndef VersionPayloadRoot
  #error VersionPayloadRoot must point to the assembled x64 version payload.
#endif
#ifndef PluginSourceRoot
  #error PluginSourceRoot must point to the canonical staged plugin.
#endif
#ifndef MarketplaceHelperSource
  #error MarketplaceHelperSource must point to manage-personal-marketplace.mjs.
#endif
#ifndef LicenseFile
  #error LicenseFile must point to the repository MIT license.
#endif
#ifndef OutputDirectory
  #error OutputDirectory must be provided by the release build.
#endif
#ifndef SetupIconFileSource
  #error SetupIconFileSource must point to the generated original ICO.
#endif

#ifdef TestActivationFault
  #ifndef TestPayloadVersion
    #error TestActivationFault requires the exact embedded TestPayloadVersion.
  #endif
#else
  #ifdef TestPayloadVersion
    #error TestPayloadVersion is only allowed in the activation-fault fixture.
  #endif
#endif
#ifdef TestPayloadVersion
  #define PreflightPayloadVersion TestPayloadVersion
#else
  #define PreflightPayloadVersion AppVersion
#endif

#define ProductName "Skill Organizer for Codex"
#define ProductId "codex-skill-organizer"
#define ProductExe "SkillOrganizerForCodex.exe"
#define Publisher "lx"
#define RepositoryUrl "https://github.com/lingxuanqjc-alt/codex-skill-organizer"

#if !FileExists(VersionPayloadRoot + "\" + ProductExe)
  #error VersionPayloadRoot does not contain SkillOrganizerForCodex.exe.
#endif
#if !FileExists(VersionPayloadRoot + "\runtime\node.exe")
  #error VersionPayloadRoot does not contain the pinned runtime\node.exe.
#endif
#if !FileExists(VersionPayloadRoot + "\app\dist\server.mjs")
  #error VersionPayloadRoot does not contain app\dist\server.mjs.
#endif
#if !FileExists(VersionPayloadRoot + "\app\dist\mcp-sidecar.mjs")
  #error VersionPayloadRoot does not contain app\dist\mcp-sidecar.mjs.
#endif
#if !FileExists(VersionPayloadRoot + "\tools\backup-state.mjs")
  #error VersionPayloadRoot does not contain tools\backup-state.mjs.
#endif
#if !FileExists(PluginSourceRoot + "\.codex-plugin\plugin.json")
  #error PluginSourceRoot is not a staged Codex plugin.
#endif
#if !FileExists(MarketplaceHelperSource)
  #error MarketplaceHelperSource is missing.
#endif
#if !FileExists(SetupIconFileSource)
  #error SetupIconFileSource is missing.
#endif

[Setup]
AppId={{A8D9081E-C5DB-4B48-A772-574427CA3A27}
AppName={#ProductName}
AppVersion={#AppVersion}
AppPublisher={#Publisher}
AppCopyright=Copyright (c) 2026 lx
AppComments=Independent community project; not affiliated with OpenAI.
AppPublisherURL={#RepositoryUrl}
AppSupportURL={#RepositoryUrl}/issues
AppUpdatesURL={#RepositoryUrl}/releases
DefaultDirName={localappdata}\Programs\SkillOrganizerForCodex
DisableDirPage=yes
UsePreviousAppDir=no
DefaultGroupName={#ProductName}
DisableProgramGroupPage=yes
LicenseFile={#LicenseFile}
OutputDir={#OutputDirectory}
OutputBaseFilename=SkillOrganizerForCodex-{#AppVersion}-win-x64-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
Uninstallable=yes
CreateUninstallRegKey=yes
UninstallDisplayName={#ProductName}
UninstallDisplayIcon={app}\{#ProductExe}
CloseApplications=force
RestartApplications=no
SetupLogging=yes
SetupIconFile={#SetupIconFileSource}
ChangesAssociations=no
ChangesEnvironment=no
VersionInfoCompany=lx
VersionInfoDescription=Local skill classification, organization, and management workbench
VersionInfoCopyright=Copyright (c) 2026 lx
VersionInfoProductName={#ProductName}

[Types]
Name: "full"; Description: "桌面工作台 + Codex 插件 / Desktop + Codex plugin"
Name: "desktop"; Description: "仅桌面工作台 / Desktop only"
Name: "custom"; Description: "自定义 / Custom"; Flags: iscustom

[Components]
Name: "workbench"; Description: "桌面工作台 / Desktop workbench"; Types: full desktop custom; Flags: fixed
Name: "codexplugin"; Description: "Codex 会话插件 / Codex conversation plugin"; Types: full

[Tasks]
Name: "startup"; Description: "登录 Windows 时启动托盘 / Start the tray at sign-in"; GroupDescription: "可选设置 / Optional settings"; Flags: unchecked

[Files]
Source: "{#VersionPayloadRoot}\*"; DestDir: "{app}\versions\{#AppVersion}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#MarketplaceHelperSource}"; DestDir: "{app}\versions\{#AppVersion}\tools"; DestName: "manage-personal-marketplace.mjs"; Flags: ignoreversion
Source: "{#PluginSourceRoot}\*"; DestDir: "{app}\versions\{#AppVersion}\plugin\{#ProductId}"; Components: codexplugin; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#ProductName}"; Filename: "{app}\{#ProductExe}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#ProductName}"; Filename: "{app}\{#ProductExe}"; WorkingDir: "{app}"
Name: "{userstartup}\{#ProductName}"; Filename: "{app}\{#ProductExe}"; WorkingDir: "{app}"; Tasks: startup

[Run]
Filename: "{app}\{#ProductExe}"; Description: "启动 {#ProductName} / Launch {#ProductName}"; Flags: nowait postinstall skipifsilent; Check: ShouldLaunchAfterInstall

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
const
  EdgeUpdateClients = 'Software\Microsoft\EdgeUpdate\Clients';
  MoveFileReplaceExisting = 1;
  MoveFileWriteThrough = 8;
  FileAttributeReparsePoint = $00000400;
  InvalidFileAttributes = $FFFFFFFF;
  DriveFixed = 3;
  ActivationFailureExitCode = 70;
  ActivationRollbackIncompleteExitCode = 74;
  PluginFailureExitCode = 72;
  UninstallRegistryKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{A8D9081E-C5DB-4B48-A772-574427CA3A27}_is1';

function MoveFileEx(
  ExistingFileName: string;
  NewFileName: string;
  Flags: Cardinal): Boolean;
  external 'MoveFileExW@kernel32.dll stdcall';

function GetFileAttributes(FileName: string): Cardinal;
  external 'GetFileAttributesW@kernel32.dll stdcall';

function GetDriveType(RootPathName: string): Cardinal;
  external 'GetDriveTypeW@kernel32.dll stdcall';

var
  PreviousCurrentExists: Boolean;
  PreviousStableExists: Boolean;
  StableLauncherBackupPath: string;
  PurgeUserData: Boolean;
  LegacyAdoptionAuthorized: Boolean;
  PreflightAttempted: Boolean;
  PreflightFailure: string;
  SetupFailureExitCode: Integer;
  PreviousVersionRootExists: Boolean;
  PreviousProductInstallExists: Boolean;
  PreviousUninstallRegistryExists: Boolean;
  PreviousCurrentNextExists: Boolean;
  PreviousStableNextExists: Boolean;
  PreviousStartMenuShortcutExists: Boolean;
  PreviousDesktopShortcutExists: Boolean;
  PreviousStartupShortcutExists: Boolean;
  PreviousUninstallArtifacts: TStringList;

function ProductRoot(): string;
begin
  Result := ExpandConstant('{app}');
end;

function ExistingPathIsUnsafeReparse(const CandidatePath: string): Boolean;
var
  Attributes: Cardinal;
begin
  Result := False;
  if not FileOrDirExists(CandidatePath) then Exit;
  Attributes := GetFileAttributes(CandidatePath);
  Result := (Attributes = InvalidFileAttributes) or
            ((Attributes and FileAttributeReparsePoint) <> 0);
end;

function IsFixedLocalPath(const CandidatePath: string): Boolean;
var
  DriveRoot: string;
begin
  DriveRoot := ExtractFileDrive(CandidatePath);
  Result := (DriveRoot <> '') and (GetDriveType(AddBackslash(DriveRoot)) = DriveFixed);
end;

function ProductTreeHasReparsePoint(const CandidatePath: string): Boolean;
var
  Attributes: Cardinal;
  FindRec: TFindRec;
  ChildPath: string;
begin
  Result := False;
  if not FileOrDirExists(CandidatePath) then Exit;
  Attributes := GetFileAttributes(CandidatePath);
  if Attributes = InvalidFileAttributes then
  begin
    Result := True;
    Exit;
  end;
  if (Attributes and FileAttributeReparsePoint) <> 0 then
  begin
    Result := True;
    Exit;
  end;
  if (Attributes and FILE_ATTRIBUTE_DIRECTORY) = 0 then Exit;

  if FindFirst(AddBackslash(CandidatePath) + '*', FindRec) then
  begin
    try
      repeat
        if (FindRec.Name <> '.') and (FindRec.Name <> '..') then
        begin
          ChildPath := AddBackslash(CandidatePath) + FindRec.Name;
          if (FindRec.Attributes and FileAttributeReparsePoint) <> 0 then
          begin
            Result := True;
            Exit;
          end;
          if ((FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0) and
             ProductTreeHasReparsePoint(ChildPath) then
          begin
            Result := True;
            Exit;
          end;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

procedure EnsureSafeProductTree();
var
  ProgramsRoot: string;
begin
  ProgramsRoot := ExpandConstant('{localappdata}\Programs');
  if (not IsFixedLocalPath(ProductRoot())) or
     ExistingPathIsUnsafeReparse(ExpandConstant('{localappdata}')) or
     ExistingPathIsUnsafeReparse(ProgramsRoot) or
     ProductTreeHasReparsePoint(ProductRoot()) then
  begin
    RaiseException(
      '检测到安装目录或其现有父目录包含 junction/symlink/reparse point，安装或卸载已在文件操作前停止。' + #13#10 +
      'The existing product directory boundary contains a junction, symlink, or reparse point; setup stopped before file operations.');
  end;
end;

function DataRoot(): string;
begin
  Result := ExpandConstant('{localappdata}\SkillOrganizerForCodex');
end;

procedure EnsureSafeDataTree();
begin
  if (not IsFixedLocalPath(DataRoot())) or ProductTreeHasReparsePoint(DataRoot()) then
  begin
    RaiseException(
      '检测到 Organizer 数据目录包含 junction/symlink/reparse point，安装、插件维护或卸载已在文件操作前停止。' + #13#10 +
      'The Organizer data boundary contains a junction, symlink, or reparse point; setup stopped before file operations.');
  end;
end;

function VersionRoot(): string;
begin
  Result := ExpandConstant('{app}\versions\{#AppVersion}');
end;

function CurrentManifestPath(): string;
begin
  Result := AddBackslash(ProductRoot()) + 'current.json';
end;

function StableLauncherPath(): string;
begin
  Result := AddBackslash(ProductRoot()) + '{#ProductExe}';
end;

function VersionLauncherPath(): string;
begin
  Result := AddBackslash(VersionRoot()) + '{#ProductExe}';
end;

function TemporaryVersionRoot(): string;
begin
  { ExtractTemporaryFiles deliberately preserves the destination constant under the setup temp root. }
  Result := AddBackslash(ExpandConstant('{tmp}')) + '{app}\versions\{#AppVersion}';
end;

function TemporaryVersionLauncherPath(): string;
begin
  Result := AddBackslash(TemporaryVersionRoot()) + '{#ProductExe}';
end;

function RollbackRoot(): string;
begin
  Result := AddBackslash(DataRoot()) + 'installer-rollback';
end;

function ShortcutRollbackRoot(): string;
begin
  Result := AddBackslash(RollbackRoot()) + 'shortcuts-before-{#AppVersion}';
end;

function UninstallRollbackRoot(): string;
begin
  Result := AddBackslash(RollbackRoot()) + 'uninstall-before-{#AppVersion}';
end;

function VersionRollbackRoot(): string;
begin
  Result := AddBackslash(RollbackRoot()) + 'version-before-{#AppVersion}';
end;

function UninstallRegistryBackupPath(): string;
begin
  Result := AddBackslash(RollbackRoot()) + 'uninstall-registry-before-{#AppVersion}.reg';
end;

function StartMenuShortcutPath(): string;
begin
  Result := ExpandConstant('{autoprograms}\{#ProductName}.lnk');
end;

function DesktopShortcutPath(): string;
begin
  Result := ExpandConstant('{autodesktop}\{#ProductName}.lnk');
end;

function StartupShortcutPath(): string;
begin
  Result := ExpandConstant('{userstartup}\{#ProductName}.lnk');
end;

function MarketplacePath(): string;
begin
  Result := AddBackslash(GetEnv('USERPROFILE')) + '.agents\plugins\marketplace.json';
end;

function PluginDestination(): string;
begin
  Result := AddBackslash(GetEnv('USERPROFILE')) + 'plugins\{#ProductId}';
end;

function LegacyConsentPath(): string;
begin
  Result := AddBackslash(DataRoot()) + 'plugin-legacy-adoption-consent.v1.json';
end;

function PluginUpdatePendingPath(): string;
begin
  Result := AddBackslash(DataRoot()) + 'plugin-update-pending.json';
end;

function IsLegacyPluginCandidate(): Boolean;
var
  ManifestText: AnsiString;
  ManifestPath: string;
begin
  Result := False;
  ManifestPath := AddBackslash(PluginDestination()) + '.codex-plugin\plugin.json';
  if FileExists(AddBackslash(PluginDestination()) + '.skill-organizer-managed.json') or
     (not LoadStringFromFile(ManifestPath, ManifestText)) then Exit;
  Result := (Pos('"version":"0.1.1"', ManifestText) > 0) or
            (Pos('"version": "0.1.1"', ManifestText) > 0);
end;

function ConfirmLegacyAdoption(): Boolean;
var
  Index: Integer;
begin
  Result := False;
  if not IsLegacyPluginCandidate() then Exit;
  for Index := 1 to ParamCount do
    if CompareText(ParamStr(Index), '/ADOPTLEGACYPLUGIN') = 0 then
    begin
      Result := True;
      Exit;
    end;
  if not WizardSilent() then
    Result := SuppressibleMsgBox(
      '检测到 Skill Organizer 0.1.1。升级会先创建并验证完整插件备份，再由 0.2.0 接管该插件目录；旧 JSON 分类状态不会导入或删除。是否继续安装插件？' + #13#10 +
      'Skill Organizer 0.1.1 was found. Setup will create and verify a full plugin backup before 0.2.0 adopts that directory. Continue with the plugin component?',
      mbConfirmation, MB_YESNO, IDNO) = IDYES;
end;

procedure PersistLegacyConsent();
var
  ConsentJson: AnsiString;
begin
  if not LegacyAdoptionAuthorized then Exit;
  if not ForceDirectories(DataRoot()) then
    RaiseException('无法创建插件接管授权目录 / Unable to create the plugin adoption consent directory.');
  ConsentJson :=
    '{"schemaVersion":1,"pluginId":"{#ProductId}@personal","fromVersion":"0.1.1",' +
    '"toVersion":"{#AppVersion}","authorized":true}' + #13#10;
  if not SaveStringToFile(LegacyConsentPath(), ConsentJson, False) then
    RaiseException('无法保存明确的 0.1.1 接管授权 / Unable to persist explicit 0.1.1 adoption consent.');
end;

function HasCommandLineSwitch(const Value: string): Boolean;
var
  Index: Integer;
begin
  Result := False;
  for Index := 1 to ParamCount do
  begin
    if CompareText(ParamStr(Index), Value) = 0 then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

function HasCommandLinePrefix(const Value: string): Boolean;
var
  Index: Integer;
  ArgumentValue: string;
begin
  Result := False;
  for Index := 1 to ParamCount do
  begin
    ArgumentValue := ParamStr(Index);
    if CompareText(Copy(ArgumentValue, 1, Length(Value)), Value) = 0 then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

function IsCodexDetected(): Boolean;
var
  ConfigRoot: string;
  ExplicitCli: string;
begin
  ExplicitCli := GetEnv('CODEX_CLI_PATH');
  ConfigRoot := AddBackslash(GetEnv('USERPROFILE')) + '.codex';
  Result := ((ExplicitCli <> '') and FileExists(ExplicitCli)) or DirExists(ConfigRoot);
end;

function HasRuntimeDescriptor(): Boolean;
begin
  Result :=
    FileExists(AddBackslash(DataRoot()) + 'runtime.json') or
    FileExists(AddBackslash(DataRoot()) + 'runtime\runtime.json');
end;

procedure StopOrganizerService(const LauncherPath: string);
var
  ExitCode: Integer;
begin
  if not HasRuntimeDescriptor() then
  begin
    Log('No Organizer runtime descriptor exists; maintenance shutdown is not required.');
    Exit;
  end;
  if not FileExists(LauncherPath) then
    RaiseException(
      '检测到 Organizer 后台描述文件，但维护启动器缺失；安装或卸载已中止。' + #13#10 +
      'An Organizer runtime descriptor exists but its maintenance launcher is missing; setup was stopped.');
  if not Exec(
    LauncherPath,
    '--shutdown-for-maintenance',
    ExtractFileDir(LauncherPath),
    SW_HIDE,
    ewWaitUntilTerminated,
    ExitCode) or (ExitCode <> 0) then
  begin
    RaiseException(
      '无法安全停止 Skill Organizer 后台，因此安装或卸载已中止。' + #13#10 +
      'The Organizer backend could not be stopped safely, so setup was stopped.');
  end;
end;

function RegistryBranchHasWebView2(RootKey: Integer; const BaseKey: string): Boolean;
var
  Names: TArrayOfString;
  Index: Integer;
  DisplayName: string;
begin
  Result := False;
  if not RegGetSubkeyNames(RootKey, BaseKey, Names) then Exit;
  for Index := 0 to GetArrayLength(Names) - 1 do
  begin
    DisplayName := '';
    RegQueryStringValue(RootKey, BaseKey + '\' + Names[Index], 'name', DisplayName);
    if Pos('webview2', Lowercase(DisplayName)) > 0 then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

function HasWebView2Runtime(): Boolean;
begin
  Result :=
    RegistryBranchHasWebView2(HKCU, EdgeUpdateClients) or
    RegistryBranchHasWebView2(HKLM32, EdgeUpdateClients) or
    RegistryBranchHasWebView2(HKLM64, EdgeUpdateClients);
end;

procedure InitializeWizard();
begin
  PreviousUninstallArtifacts := TStringList.Create;
  PreviousUninstallArtifacts.CaseSensitive := False;
  if HasCommandLinePrefix('/COMPONENTS=') or
     HasCommandLinePrefix('/TYPE=') or
     HasCommandLinePrefix('/LOADINF=') then
  begin
    Log('Preserving the explicit command-line or answer-file component selection.');
    Exit;
  end;
  if IsCodexDetected() then
    WizardSelectComponents('workbench,codexplugin')
  else
    WizardSelectComponents('workbench,!codexplugin');
end;

procedure ExtractPreflightPayload();
var
  ExtractedCount: Integer;
begin
  { This reuses the canonical [Files] payload. It does not add a second copy to the installer. }
  ExtractedCount := ExtractTemporaryFiles('{app}\versions\{#AppVersion}\*');
  if (ExtractedCount <= 0) or
     (not FileExists(TemporaryVersionLauncherPath())) or
     (not FileExists(AddBackslash(TemporaryVersionRoot()) + 'runtime\node.exe')) or
     (not FileExists(AddBackslash(TemporaryVersionRoot()) + 'app\dist\server.mjs')) or
     (not FileExists(AddBackslash(TemporaryVersionRoot()) + 'tools\backup-state.mjs')) then
  begin
    RaiseException(
      '安装包中的预检载荷不完整，因此安装没有写入程序文件。' + #13#10 +
      'The preflight payload is incomplete; no program files were installed.');
  end;
  Log('Extracted and verified the bundled preflight payload.');
end;

procedure BackupExistingDatabasePreflight();
var
  NodePath: string;
  HelperPath: string;
  Arguments: string;
  ExitCode: Integer;
begin
  NodePath := AddBackslash(TemporaryVersionRoot()) + 'runtime\node.exe';
  HelperPath := AddBackslash(TemporaryVersionRoot()) + 'tools\backup-state.mjs';
  Arguments :=
    AddQuotes(HelperPath) +
    ' --data-dir ' + AddQuotes(DataRoot()) +
    ' --version ' + AddQuotes('{#PreflightPayloadVersion}');

  if not Exec(NodePath, Arguments, TemporaryVersionRoot(), SW_HIDE,
    ewWaitUntilTerminated, ExitCode) then
  begin
    Log('Unable to launch the bundled backup runtime: ' + SysErrorMessage(ExitCode));
    if (ExitCode = 577) or (ExitCode = 1260) then
      RaiseException(
        '企业应用控制策略阻止了安装包内的 Node 运行时。必须由组织策略信任此发布物或由管理员明确放行；安装没有写入程序文件。' + #13#10 +
        'Enterprise App Control blocked the bundled Node runtime. The release must be trusted by organizational policy or explicitly allowed by an administrator; no program files were installed.');
    RaiseException(
      '无法启动安装包内的 SQLite 备份运行时，因此安装没有写入程序文件。请查看安装日志。' + #13#10 +
      'The bundled SQLite backup runtime could not be started; no program files were installed.');
  end;
  if ExitCode <> 0 then
  begin
    RaiseException(
      '无法创建并验证 SQLite 升级备份，因此安装没有写入程序文件。请查看安装日志。' + #13#10 +
      'The verified SQLite upgrade backup failed; no program files were installed.');
  end;
  Log('Completed the verified SQLite upgrade backup preflight.');
end;

procedure LogHealthCheckOutput(const S: String; const Error, FirstLine: Boolean);
begin
  if Error then
    Log('Health-check output capture failed.')
  else
    Log('Health-check output: ' + S);
end;

procedure VerifyVersionHealthPreflight();
var
  ExitCode: Integer;
begin
  if not ExecAndLogOutput(
    TemporaryVersionLauncherPath(),
    '--health-check --upgrade-backup-result ' +
      AddQuotes(AddBackslash(DataRoot()) + 'upgrade-backup-result.json'),
    TemporaryVersionRoot(),
    SW_HIDE,
    ewWaitUntilTerminated,
    ExitCode,
    @LogHealthCheckOutput) then
  begin
    Log('Unable to launch the bundled health-check executable: ' + SysErrorMessage(ExitCode));
    if (ExitCode = 577) or (ExitCode = 1260) then
      RaiseException(
        '企业应用控制策略阻止了新版健康检查。必须由组织策略信任此发布物或由管理员明确放行；安装没有写入程序文件。' + #13#10 +
        'Enterprise App Control blocked the new-version health check. The release must be trusted by organizational policy or explicitly allowed by an administrator; no program files were installed.');
    RaiseException(
      '无法启动新版健康检查，因此安装没有写入程序文件，原版本保持不变。请查看安装日志。' + #13#10 +
      'The new-version health check could not be started; no program files were installed and the previous version remains unchanged.');
  end;
  if ExitCode <> 0 then
  begin
    Log('Bundled health-check process exited with code ' + IntToStr(ExitCode) + '.');
    RaiseException(
      '新版健康检查失败，因此安装没有写入程序文件，原版本保持不变。请查看安装日志。' + #13#10 +
      'The new version failed its health check; no program files were installed and the previous version remains unchanged.');
  end;
  Log('Completed the exact-version health preflight.');
end;

procedure CaptureShortcut(
  const ShortcutPath: string;
  const BackupName: string;
  var PreviouslyExisted: Boolean);
begin
  PreviouslyExisted := FileExists(ShortcutPath);
  if PreviouslyExisted then
  begin
    if not ForceDirectories(ShortcutRollbackRoot()) then
      RaiseException('无法创建快捷方式回滚目录 / Unable to create the shortcut rollback directory.');
    if not CopyFile(
      ShortcutPath,
      AddBackslash(ShortcutRollbackRoot()) + BackupName,
      False) then
    begin
      RaiseException('无法保存快捷方式回滚副本 / Unable to preserve a shortcut rollback copy.');
    end;
  end;
end;

procedure CaptureUninstallArtifacts();
var
  FindRec: TFindRec;
  SourcePath: string;
  BackupPath: string;
begin
  PreviousUninstallArtifacts.Clear;
  if DirExists(UninstallRollbackRoot()) and
     (not DelTree(UninstallRollbackRoot(), True, True, True)) then
  begin
    RaiseException('无法清理卸载器回滚目录 / Unable to reset the uninstaller rollback directory.');
  end;
  if not ForceDirectories(UninstallRollbackRoot()) then
    RaiseException('无法创建卸载器回滚目录 / Unable to create the uninstaller rollback directory.');

  if FindFirst(AddBackslash(ProductRoot()) + 'unins*', FindRec) then
  begin
    try
      repeat
        if (FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) = 0 then
        begin
          SourcePath := AddBackslash(ProductRoot()) + FindRec.Name;
          BackupPath := AddBackslash(UninstallRollbackRoot()) + FindRec.Name;
          if not CopyFile(SourcePath, BackupPath, False) then
            RaiseException('无法保存卸载器回滚副本 / Unable to preserve an uninstaller rollback copy.');
          PreviousUninstallArtifacts.Add(FindRec.Name);
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

function CopyDirectoryTree(const SourceRoot: string; const DestinationRoot: string): Boolean;
var
  FindRec: TFindRec;
  SourcePath: string;
  DestinationPath: string;
begin
  Result := False;
  if not DirExists(SourceRoot) then Exit;
  if not ForceDirectories(DestinationRoot) then Exit;

  if FindFirst(AddBackslash(SourceRoot) + '*', FindRec) then
  begin
    try
      repeat
        if (FindRec.Name <> '.') and (FindRec.Name <> '..') then
        begin
          if (FindRec.Attributes and FileAttributeReparsePoint) <> 0 then
          begin
            Log('Refusing to copy a reparse point in the installed version rollback boundary: ' + FindRec.Name);
            Exit;
          end;
          SourcePath := AddBackslash(SourceRoot) + FindRec.Name;
          DestinationPath := AddBackslash(DestinationRoot) + FindRec.Name;
          if (FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then
          begin
            if not CopyDirectoryTree(SourcePath, DestinationPath) then Exit;
          end
          else if not CopyFile(SourcePath, DestinationPath, False) then
            Exit;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
  Result := True;
end;

procedure CaptureVersionRoot();
begin
  if DirExists(VersionRollbackRoot()) and
     (not DelTree(VersionRollbackRoot(), True, True, True)) then
  begin
    RaiseException('无法清理旧程序回滚目录 / Unable to reset the previous-program rollback directory.');
  end;
  if PreviousVersionRootExists and
     (not CopyDirectoryTree(VersionRoot(), VersionRollbackRoot())) then
  begin
    RaiseException(
      '无法完整备份同版本的既有程序目录，因此安装在写入前停止。' + #13#10 +
      'The existing same-version program directory could not be fully backed up, so setup stopped before writing program files.');
  end;
end;

procedure CaptureUninstallRegistry();
var
  RegPath: string;
  Arguments: string;
  ExitCode: Integer;
begin
  DeleteFile(UninstallRegistryBackupPath());
  if not PreviousUninstallRegistryExists then Exit;

  RegPath := ExpandConstant('{sys}\reg.exe');
  Arguments :=
    'export ' + AddQuotes('HKCU\' + UninstallRegistryKey) + ' ' +
    AddQuotes(UninstallRegistryBackupPath()) + ' /y';
  if not Exec(RegPath, Arguments, RollbackRoot(), SW_HIDE,
    ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) or
    (not FileExists(UninstallRegistryBackupPath())) then
  begin
    RaiseException(
      '无法完整备份 Windows 卸载注册信息，因此安装在写入前停止。' + #13#10 +
      'The Windows uninstall registration could not be fully backed up, so setup stopped before writing program files.');
  end;
end;

procedure CaptureActivationRollbackState();
begin
  PreviousProductInstallExists := DirExists(ProductRoot());
  PreviousUninstallRegistryExists := RegKeyExists(HKCU, UninstallRegistryKey);
  PreviousVersionRootExists := DirExists(VersionRoot());
  PreviousCurrentNextExists := FileOrDirExists(CurrentManifestPath() + '.next');
  PreviousStableNextExists := FileOrDirExists(StableLauncherPath() + '.next');
  if FileExists(CurrentManifestPath() + '.next') or
     PreviousStableNextExists or
     FileOrDirExists(CurrentManifestPath() + '.rollback-{#AppVersion}') or
     FileOrDirExists(StableLauncherPath() + '.rollback-{#AppVersion}') then
  begin
    RaiseException(
      '检测到上一次激活留下的临时文件，因此安装在写入前停止。' + #13#10 +
      'A stale activation journal file exists, so setup stopped before writing program files.');
  end;
  PreviousCurrentExists := FileExists(CurrentManifestPath());
  PreviousStableExists := FileExists(StableLauncherPath());
  StableLauncherBackupPath := AddBackslash(RollbackRoot()) + 'launcher-before-{#AppVersion}.exe';

  if not ForceDirectories(RollbackRoot()) then
    RaiseException('无法创建升级回滚目录 / Unable to create the upgrade rollback directory.');
  if PreviousCurrentExists and (not CopyFile(
    CurrentManifestPath(),
    AddBackslash(RollbackRoot()) + 'current-before-{#AppVersion}.json',
    False)) then
  begin
    RaiseException('无法保存升级回滚清单 / Unable to save the upgrade rollback manifest.');
  end;
  if PreviousStableExists and
     (not CopyFile(StableLauncherPath(), StableLauncherBackupPath, False)) then
  begin
    RaiseException('无法保存稳定启动器回滚副本 / Unable to save the stable launcher rollback copy.');
  end;

  if DirExists(ShortcutRollbackRoot()) and
     (not DelTree(ShortcutRollbackRoot(), True, True, True)) then
  begin
    RaiseException('无法清理快捷方式回滚目录 / Unable to reset the shortcut rollback directory.');
  end;
  CaptureShortcut(StartMenuShortcutPath(), 'start-menu.lnk', PreviousStartMenuShortcutExists);
  CaptureShortcut(DesktopShortcutPath(), 'desktop.lnk', PreviousDesktopShortcutExists);
  CaptureShortcut(StartupShortcutPath(), 'startup.lnk', PreviousStartupShortcutExists);
  CaptureUninstallArtifacts();
  CaptureVersionRoot();
  CaptureUninstallRegistry();
end;

function PrepareToInstall(var NeedsRestart: Boolean): string;
begin
  NeedsRestart := False;
  if PreflightAttempted then
  begin
    Result := PreflightFailure;
    Exit;
  end;

  PreflightAttempted := True;
  PreflightFailure := '';
  try
    if CompareText(
      ProductRoot(),
      ExpandConstant('{localappdata}\Programs\SkillOrganizerForCodex')) <> 0 then
    begin
      RaiseException(
        '安装目录必须保持为当前用户的固定产品目录 / ' +
        'The install directory must remain the fixed per-user product path.');
    end;

    EnsureSafeProductTree();
    EnsureSafeDataTree();
    StopOrganizerService(StableLauncherPath());
    ExtractPreflightPayload();
    BackupExistingDatabasePreflight();
    VerifyVersionHealthPreflight();
    CaptureActivationRollbackState();
    Log('Installer preflight completed before the normal file-copy stage.');
  except
    PreflightFailure := GetExceptionMessage();
    Log('Installer preflight failed: ' + PreflightFailure);
  end;
  Result := PreflightFailure;
end;

function RestoreCurrentManifest(): Boolean;
var
  BackupPath: string;
  RestorePath: string;
begin
  if PreviousCurrentExists then
  begin
    BackupPath := AddBackslash(RollbackRoot()) + 'current-before-{#AppVersion}.json';
    RestorePath := CurrentManifestPath() + '.rollback-{#AppVersion}';
    DeleteFile(RestorePath);
    Result := FileExists(BackupPath) and CopyFile(BackupPath, RestorePath, False);
    if Result then
      Result := MoveFileEx(
        RestorePath,
        CurrentManifestPath(),
        MoveFileReplaceExisting or MoveFileWriteThrough);
    if not Result then DeleteFile(RestorePath);
  end
  else
  begin
    Result := (not FileExists(CurrentManifestPath())) or DeleteFile(CurrentManifestPath());
  end;
end;

function RestoreStableLauncher(): Boolean;
var
  RestorePath: string;
begin
  if PreviousStableExists and FileExists(StableLauncherBackupPath) then
  begin
    RestorePath := StableLauncherPath() + '.rollback-{#AppVersion}';
    DeleteFile(RestorePath);
    Result := CopyFile(StableLauncherBackupPath, RestorePath, False);
    if Result then
      Result := MoveFileEx(
        RestorePath,
        StableLauncherPath(),
        MoveFileReplaceExisting or MoveFileWriteThrough);
    if not Result then DeleteFile(RestorePath);
  end
  else if not PreviousStableExists then
  begin
    Result := (not FileExists(StableLauncherPath())) or DeleteFile(StableLauncherPath());
  end
  else
    Result := False;
end;

function UpdateStableLauncher(): Boolean;
var
  NextPath: string;
begin
  NextPath := StableLauncherPath() + '.next';
  DeleteFile(NextPath);
  Result := CopyFile(VersionLauncherPath(), NextPath, False);
  if Result then
    Result := MoveFileEx(
      NextPath,
      StableLauncherPath(),
      MoveFileReplaceExisting or MoveFileWriteThrough);
  if not Result then DeleteFile(NextPath);
end;

function CommitCurrentManifest(): Boolean;
var
  CurrentJson: AnsiString;
  NextPath: string;
begin
  CurrentJson :=
    '{"schemaVersion":1,"version":"{#AppVersion}","relativePath":"versions/{#AppVersion}"}' + #13#10;
  NextPath := CurrentManifestPath() + '.next';
  DeleteFile(NextPath);
  Result := SaveStringToFile(NextPath, CurrentJson, False);
  if Result then
    Result := MoveFileEx(
      NextPath,
      CurrentManifestPath(),
      MoveFileReplaceExisting or MoveFileWriteThrough);
  if not Result then
  begin
    DeleteFile(NextPath);
  end;
end;

function RestoreShortcut(
  const ShortcutPath: string;
  const BackupName: string;
  const PreviouslyExisted: Boolean): Boolean;
var
  BackupPath: string;
begin
  BackupPath := AddBackslash(ShortcutRollbackRoot()) + BackupName;
  if PreviouslyExisted then
  begin
    Result := FileExists(BackupPath) and CopyFile(BackupPath, ShortcutPath, False);
  end;
  if not PreviouslyExisted then
    Result := (not FileExists(ShortcutPath)) or DeleteFile(ShortcutPath);
end;

function RestoreUninstallArtifacts(): Boolean;
var
  FindRec: TFindRec;
  CurrentPath: string;
  Index: Integer;
  BackupPath: string;
  DestinationPath: string;
begin
  Result := True;
  if FindFirst(AddBackslash(ProductRoot()) + 'unins*', FindRec) then
  begin
    try
      repeat
        if (FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) = 0 then
        begin
          CurrentPath := AddBackslash(ProductRoot()) + FindRec.Name;
          if not DeleteFile(CurrentPath) then Result := False;
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;

  for Index := 0 to PreviousUninstallArtifacts.Count - 1 do
  begin
    BackupPath := AddBackslash(UninstallRollbackRoot()) + PreviousUninstallArtifacts[Index];
    DestinationPath := AddBackslash(ProductRoot()) + PreviousUninstallArtifacts[Index];
    if (not FileExists(BackupPath)) or
       (not CopyFile(BackupPath, DestinationPath, False)) then
      Result := False;
  end;
end;

function RestoreVersionRoot(): Boolean;
begin
  Result := True;
  if DirExists(VersionRoot()) and
     (not DelTree(VersionRoot(), True, True, True)) then
  begin
    Result := False;
    Exit;
  end;
  if PreviousVersionRootExists then
    Result := CopyDirectoryTree(VersionRollbackRoot(), VersionRoot());
end;

function RestoreUninstallRegistry(): Boolean;
var
  RegPath: string;
  Arguments: string;
  ExitCode: Integer;
begin
  Result := True;
  if RegKeyExists(HKCU, UninstallRegistryKey) and
     (not RegDeleteKeyIncludingSubkeys(HKCU, UninstallRegistryKey)) then
  begin
    Result := False;
    Exit;
  end;
  if not PreviousUninstallRegistryExists then Exit;
  if not FileExists(UninstallRegistryBackupPath()) then
  begin
    Result := False;
    Exit;
  end;

  RegPath := ExpandConstant('{sys}\reg.exe');
  Arguments := 'import ' + AddQuotes(UninstallRegistryBackupPath());
  Result := Exec(RegPath, Arguments, RollbackRoot(), SW_HIDE,
    ewWaitUntilTerminated, ExitCode) and (ExitCode = 0);
end;

function RemoveSetupCreatedFile(
  const CandidatePath: string;
  const PreviouslyExisted: Boolean): Boolean;
begin
  if PreviouslyExisted then
  begin
    Result := True;
    Exit;
  end;
  if not FileOrDirExists(CandidatePath) then
  begin
    Result := True;
    Exit;
  end;
  { Setup only creates regular activation journal files. Never delete an unexpected directory. }
  Result := FileExists(CandidatePath) and DeleteFile(CandidatePath);
end;

function RollbackFailedActivation(): Boolean;
begin
  Result := RestoreCurrentManifest();
  if not RestoreStableLauncher() then Result := False;
  if not RemoveSetupCreatedFile(
    CurrentManifestPath() + '.next',
    PreviousCurrentNextExists) then Result := False;
  if not RemoveSetupCreatedFile(
    StableLauncherPath() + '.next',
    PreviousStableNextExists) then Result := False;
  if not RemoveSetupCreatedFile(
    CurrentManifestPath() + '.rollback-{#AppVersion}',
    False) then Result := False;
  if not RemoveSetupCreatedFile(
    StableLauncherPath() + '.rollback-{#AppVersion}',
    False) then Result := False;

  if not RestoreShortcut(
    StartMenuShortcutPath(),
    'start-menu.lnk',
    PreviousStartMenuShortcutExists) then Result := False;
  if not RestoreShortcut(
    DesktopShortcutPath(),
    'desktop.lnk',
    PreviousDesktopShortcutExists) then Result := False;
  if not RestoreShortcut(
    StartupShortcutPath(),
    'startup.lnk',
    PreviousStartupShortcutExists) then Result := False;
  if not RestoreUninstallArtifacts() then Result := False;
  if not RestoreVersionRoot() then Result := False;
  if not RestoreUninstallRegistry() then Result := False;
  if not PreviousProductInstallExists then
  begin
    RemoveDir(AddBackslash(ProductRoot()) + 'versions');
    RemoveDir(ProductRoot());
  end;
end;

procedure ActivateVersion();
begin
  if not UpdateStableLauncher() then
    RaiseException('无法原子更新稳定启动器 / Unable to atomically update the stable launcher.');

#ifdef TestActivationFault
  { Compiled only into the isolated release-gate fixture. Production setup has no runtime fault switch. }
  Log('TEST ONLY activation fault hook fired after stable launcher replacement.');
  RaiseException('TEST ONLY deterministic post-copy activation failure.');
#endif

  if not CommitCurrentManifest() then
    RaiseException('无法激活新版，已恢复原版本 / Unable to activate the new version; the previous version was restored.');
end;

procedure RegisterCodexPlugin();
var
  NodePath: string;
  HelperPath: string;
  PluginSource: string;
  Arguments: string;
  ExitCode: Integer;
  MarkerPath: string;
  MarkerStagingPath: string;
  AdoptValue: string;
  CleanupSucceeded: Boolean;
begin
  if not WizardIsComponentSelected('codexplugin') then Exit;

  LegacyAdoptionAuthorized := ConfirmLegacyAdoption();
  if IsLegacyPluginCandidate() and (not LegacyAdoptionAuthorized) then
  begin
    SuppressibleMsgBox(
      '已保留现有 0.1.1 插件，桌面工作台仍已安装。稍后可重新运行安装器并明确确认插件接管。' + #13#10 +
      'The existing 0.1.1 plugin was preserved. The desktop workbench is installed; rerun setup later to explicitly adopt the plugin.',
      mbInformation, MB_OK, IDOK);
    Exit;
  end;
  PersistLegacyConsent();
  if LegacyAdoptionAuthorized then AdoptValue := 'true' else AdoptValue := 'false';

  NodePath := AddBackslash(VersionRoot()) + 'runtime\node.exe';
  HelperPath := AddBackslash(VersionRoot()) + 'tools\manage-personal-marketplace.mjs';
  PluginSource := AddBackslash(VersionRoot()) + 'plugin\{#ProductId}';
  MarkerPath := AddBackslash(ProductRoot()) + 'plugin-registered.marker';
  MarkerStagingPath := MarkerPath + '.next';
  DeleteFile(MarkerStagingPath);
  if not SaveStringToFile(MarkerStagingPath, '{#AppVersion}' + #13#10, False) then
  begin
    DeleteFile(LegacyConsentPath());
    SetupFailureExitCode := PluginFailureExitCode;
    SuppressibleMsgBox(
      '桌面工作台已安装，但无法预先验证插件所有权标记写入，因此没有修改插件或 marketplace。' + #13#10 +
      'The desktop workbench is installed, but setup could not stage its plugin ownership marker, so the plugin and marketplace were not changed.',
      mbError, MB_OK, IDOK);
    Exit;
  end;
  Arguments :=
    AddQuotes(HelperPath) + ' install' +
    ' --marketplace ' + AddQuotes(MarketplacePath()) +
    ' --plugin-destination ' + AddQuotes(PluginDestination()) +
    ' --data-dir ' + AddQuotes(DataRoot()) +
    ' --plugin-source ' + AddQuotes(PluginSource) +
    ' --version {#AppVersion}' +
    ' --adopt-legacy-0.1.1 ' + AdoptValue +
    ' --defer-finalize true';

  if not Exec(NodePath, Arguments, VersionRoot(), SW_HIDE, ewWaitUntilTerminated, ExitCode) then
  begin
    DeleteFile(MarkerStagingPath);
    DeleteFile(LegacyConsentPath());
    SetupFailureExitCode := PluginFailureExitCode;
    SuppressibleMsgBox(
      '桌面工作台已安装，但 Codex 插件注册失败。安装器没有覆盖现有 marketplace 条目。' + #13#10 +
      'The desktop workbench is installed, but plugin registration failed. Existing marketplace entries were preserved.',
      mbError, MB_OK, IDOK);
    Exit;
  end;
  if ExitCode = 75 then
  begin
    DeleteFile(MarkerStagingPath);
    SuppressibleMsgBox(
      '插件文件正被 Codex 使用，已保存经过校验的待处理替换。请完全重启 Codex；新任务会重试并验证 0.2.0。' + #13#10 +
      'Codex is using the plugin files. A verified pending replacement was saved; fully restart Codex and a new task will retry it.',
      mbInformation, MB_OK, IDOK);
    Exit;
  end;
  if ExitCode <> 0 then
  begin
    DeleteFile(MarkerStagingPath);
    DeleteFile(LegacyConsentPath());
    SetupFailureExitCode := PluginFailureExitCode;
    SuppressibleMsgBox(
      '桌面工作台已安装，但插件安全校验失败（代码 ' + IntToStr(ExitCode) + '）。现有插件与 marketplace 已保留。' + #13#10 +
      'Plugin safety validation failed. The existing plugin and marketplace were preserved.',
      mbError, MB_OK, IDOK);
    Exit;
  end;

  if not MoveFileEx(
    MarkerStagingPath,
    MarkerPath,
    MoveFileReplaceExisting or MoveFileWriteThrough) then
  begin
    DeleteFile(MarkerStagingPath);
    Arguments :=
      AddQuotes(HelperPath) + ' rollback-install' +
      ' --marketplace ' + AddQuotes(MarketplacePath()) +
      ' --plugin-destination ' + AddQuotes(PluginDestination()) +
      ' --data-dir ' + AddQuotes(DataRoot()) +
      ' --version {#AppVersion}';
    CleanupSucceeded := Exec(NodePath, Arguments, VersionRoot(), SW_HIDE,
      ewWaitUntilTerminated, ExitCode) and (ExitCode = 0);
    DeleteFile(LegacyConsentPath());
    SetupFailureExitCode := PluginFailureExitCode;
    if CleanupSucceeded then
      SuppressibleMsgBox(
        '桌面工作台已安装，但插件所有权标记无法原子提交；安装器已撤销插件和 marketplace 变更。' + #13#10 +
        'The desktop workbench is installed, but the plugin ownership marker could not be committed atomically; plugin and marketplace changes were reverted.',
        mbError, MB_OK, IDOK)
    else
      SuppressibleMsgBox(
        '桌面工作台已安装，但插件所有权标记和补偿清理都失败。请保留安装日志并重新运行安装器；不要手工删除插件目录。' + #13#10 +
        'The desktop workbench is installed, but both marker commit and compensating cleanup failed. Preserve the setup log and rerun setup; do not delete the plugin directory manually.',
        mbError, MB_OK, IDOK);
    Exit;
  end;

  Arguments :=
    AddQuotes(HelperPath) + ' finalize-install' +
    ' --marketplace ' + AddQuotes(MarketplacePath()) +
    ' --plugin-destination ' + AddQuotes(PluginDestination()) +
    ' --data-dir ' + AddQuotes(DataRoot()) +
    ' --version {#AppVersion}';
  CleanupSucceeded := Exec(NodePath, Arguments, VersionRoot(), SW_HIDE,
    ewWaitUntilTerminated, ExitCode) and (ExitCode = 0);
  if not CleanupSucceeded then
  begin
    DeleteFile(MarkerPath);
    Arguments :=
      AddQuotes(HelperPath) + ' rollback-install' +
      ' --marketplace ' + AddQuotes(MarketplacePath()) +
      ' --plugin-destination ' + AddQuotes(PluginDestination()) +
      ' --data-dir ' + AddQuotes(DataRoot()) +
      ' --version {#AppVersion}';
    CleanupSucceeded := Exec(NodePath, Arguments, VersionRoot(), SW_HIDE,
      ewWaitUntilTerminated, ExitCode) and (ExitCode = 0);
    DeleteFile(LegacyConsentPath());
    SetupFailureExitCode := PluginFailureExitCode;
    if CleanupSucceeded then
      SuppressibleMsgBox(
        '桌面工作台已安装，但插件提交无法完成；安装器已恢复此前的插件和 marketplace。' + #13#10 +
        'The desktop workbench is installed, but plugin finalization failed; the prior plugin and marketplace were restored.',
        mbError, MB_OK, IDOK)
    else
      SuppressibleMsgBox(
        '桌面工作台已安装，但插件提交和回滚都失败。请保留安装日志并重新运行安装器；不要手工删除插件目录。' + #13#10 +
        'The desktop workbench is installed, but plugin finalization and rollback both failed. Preserve the setup log and rerun setup; do not delete the plugin directory manually.',
        mbError, MB_OK, IDOK);
    Exit;
  end;
  DeleteFile(LegacyConsentPath());

  if IsCodexDetected() then
  begin
    if not Exec(VersionLauncherPath(), '--complete-plugin-install', VersionRoot(), SW_HIDE,
      ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
    begin
      SuppressibleMsgBox(
        '插件源已安全注册，但 Codex 尚未完成安装。请重启 Codex，并在新任务中打开 Skill Organizer。' + #13#10 +
        'The plugin source is registered, but Codex has not completed installation. Restart Codex and use a new task.',
        mbInformation, MB_OK, IDOK);
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  FailureMessage: string;
  RollbackSucceeded: Boolean;
begin
  if CurStep = ssInstall then
    EnsureSafeProductTree();

  if CurStep = ssPostInstall then
  begin
    EnsureSafeProductTree();
    EnsureSafeDataTree();
    try
      ActivateVersion();
    except
    begin
      FailureMessage := GetExceptionMessage();
      try
        RollbackSucceeded := RollbackFailedActivation();
      except
        RollbackSucceeded := False;
        Log('Activation rollback raised an exception: ' + GetExceptionMessage());
      end;
      if RollbackSucceeded then
      begin
        SetupFailureExitCode := ActivationFailureExitCode;
        Log('Activation failed; rollback complete; setup will exit with code 70: ' + FailureMessage);
      end
      else
      begin
        SetupFailureExitCode := ActivationRollbackIncompleteExitCode;
        Log('Activation failed; rollback incomplete; setup will exit with code 74: ' + FailureMessage);
      end;
      if not WizardSilent() then
      begin
        if RollbackSucceeded then
          FailureMessage := FailureMessage + #13#10 +
            '原版本已恢复；安装器将返回非零退出码。' + #13#10 +
            'The previous version was restored and setup will return a non-zero exit code.'
        else
          FailureMessage := FailureMessage + #13#10 +
            '回滚未能完整完成，请保留安装日志并停止使用新版本。' + #13#10 +
            'Rollback was incomplete; preserve the setup log and do not use the new version.';
        SuppressibleMsgBox(FailureMessage, mbError, MB_OK, IDOK);
      end;
    end;
    end;

    if SetupFailureExitCode = 0 then
    begin
      try
        RegisterCodexPlugin();
      except
      begin
        FailureMessage := GetExceptionMessage();
        SetupFailureExitCode := PluginFailureExitCode;
        Log('Desktop activation succeeded but the optional plugin boundary failed: ' + FailureMessage);
        if not WizardSilent() then
          SuppressibleMsgBox(
            FailureMessage + #13#10 +
            '桌面工作台已经激活；可选插件可能处于部分完成状态。请保留安装日志并重新运行安装器。' + #13#10 +
            'The desktop workbench is active, but the optional plugin may be partially complete. Preserve the setup log and rerun setup.',
            mbError, MB_OK, IDOK);
      end;
      end;
    end;

    if SetupFailureExitCode = 0 then
    begin
      if (not WizardSilent()) and (not HasWebView2Runtime()) then
      begin
        SuppressibleMsgBox(
          '未检测到 Microsoft Edge WebView2 Runtime。应用会回退到默认浏览器；安装 WebView2 后可使用独立窗口。' + #13#10 +
          'Microsoft Edge WebView2 Runtime was not detected. The workbench will fall back to your default browser.',
          mbInformation, MB_OK, IDOK);
      end;
    end;
  end;
end;

function ShouldLaunchAfterInstall(): Boolean;
begin
  Result := SetupFailureExitCode = 0;
end;

function GetCustomSetupExitCode(): Integer;
begin
  Result := SetupFailureExitCode;
end;

procedure DeinitializeSetup();
begin
  if Assigned(PreviousUninstallArtifacts) then
    PreviousUninstallArtifacts.Free();
end;

function ShowUninstallOptions(): Boolean;
var
  Form: TSetupForm;
  LabelText: TNewStaticText;
  PurgeCheck: TNewCheckBox;
  OkButton: TNewButton;
  CancelButton: TNewButton;
begin
  Form := CreateCustomForm(ScaleX(460), ScaleY(180), False, True);
  try
    Form.Caption := '卸载 {#ProductName} / Uninstall';
    Form.Position := poScreenCenter;

    LabelText := TNewStaticText.Create(Form);
    LabelText.Parent := Form;
    LabelText.Left := ScaleX(20);
    LabelText.Top := ScaleY(18);
    LabelText.Width := ScaleX(420);
    LabelText.Height := ScaleY(58);
    LabelText.AutoSize := False;
    LabelText.WordWrap := True;
    LabelText.Caption :=
      '默认保留分类数据库、隔离区和日志。仅在不再需要恢复数据时勾选彻底删除。' + #13#10 +
      'Data, quarantine entries, and logs are preserved by default.';

    PurgeCheck := TNewCheckBox.Create(Form);
    PurgeCheck.Parent := Form;
    PurgeCheck.Left := ScaleX(20);
    PurgeCheck.Top := ScaleY(86);
    PurgeCheck.Width := ScaleX(420);
    PurgeCheck.Caption := '彻底删除所有本地数据 / Permanently delete all local data';
    PurgeCheck.Checked := False;

    OkButton := TNewButton.Create(Form);
    OkButton.Parent := Form;
    OkButton.Left := ScaleX(272);
    OkButton.Top := ScaleY(132);
    OkButton.Width := ScaleX(80);
    OkButton.Caption := '继续 / OK';
    OkButton.ModalResult := mrOk;
    OkButton.Default := True;

    CancelButton := TNewButton.Create(Form);
    CancelButton.Parent := Form;
    CancelButton.Left := ScaleX(360);
    CancelButton.Top := ScaleY(132);
    CancelButton.Width := ScaleX(80);
    CancelButton.Caption := '取消';
    CancelButton.ModalResult := mrCancel;
    CancelButton.Cancel := True;

    Result := Form.ShowModal() = mrOk;
    if Result then PurgeUserData := PurgeCheck.Checked;
  finally
    Form.Free();
  end;
end;

function InitializeUninstall(): Boolean;
begin
  EnsureSafeProductTree();
  EnsureSafeDataTree();
  PurgeUserData := HasCommandLineSwitch('/PURGEDATA');
  if UninstallSilent() then
    Result := True
  else
    Result := ShowUninstallOptions();
end;

procedure PurgeOrganizerData();
var
  PurgeSucceeded: Boolean;
begin
  if not PurgeUserData then Exit;
  EnsureSafeDataTree();
  PurgeSucceeded := True;
  if DirExists(DataRoot()) then
    PurgeSucceeded := DelTree(DataRoot(), True, True, True);
  if (not PurgeSucceeded) or FileOrDirExists(DataRoot()) then
  begin
    RaiseException(
      '无法彻底删除 Organizer 数据目录；卸载已停止。' + #13#10 +
      'The Organizer data directory could not be purged; uninstall stopped.');
  end;
end;

procedure UnregisterCodexPlugin();
var
  NodePath: string;
  HelperPath: string;
  Arguments: string;
  ExitCode: Integer;
begin
  if (not FileExists(AddBackslash(ProductRoot()) + 'plugin-registered.marker')) and
     (not FileExists(AddBackslash(PluginDestination()) + '.skill-organizer-managed.json')) and
     (not FileExists(PluginUpdatePendingPath())) then Exit;
  NodePath := AddBackslash(VersionRoot()) + 'runtime\node.exe';
  HelperPath := AddBackslash(VersionRoot()) + 'tools\manage-personal-marketplace.mjs';
  if (not FileExists(NodePath)) or (not FileExists(HelperPath)) then
    RaiseException('插件安全卸载组件缺失，卸载已停止 / Safe plugin removal components are missing; uninstall stopped.');

  if FileExists(VersionLauncherPath()) then
  begin
    if not Exec(VersionLauncherPath(), '--remove-plugin-install', VersionRoot(), SW_HIDE,
      ewWaitUntilTerminated, ExitCode) then
      RaiseException('无法调用 Codex 插件卸载边界 / Unable to invoke the Codex plugin removal boundary.');
    if (ExitCode <> 0) and (ExitCode <> 20) then
      RaiseException(
        'Codex 原生插件移除失败；为避免留下损坏来源，卸载已停止。请先在 Codex 插件管理中移除 Organizer。' + #13#10 +
        'Native Codex plugin removal failed. Uninstall stopped to avoid leaving a broken source.');
  end;

  Arguments :=
    AddQuotes(HelperPath) + ' remove' +
    ' --marketplace ' + AddQuotes(MarketplacePath()) +
    ' --plugin-destination ' + AddQuotes(PluginDestination()) +
    ' --data-dir ' + AddQuotes(DataRoot());
  if not Exec(NodePath, Arguments, VersionRoot(), SW_HIDE, ewWaitUntilTerminated, ExitCode)
    or (ExitCode <> 0) then
  begin
    RaiseException(
      'Codex 插件条目未能安全移除；卸载已停止，其他 marketplace 条目未被修改。' + #13#10 +
      'The Organizer plugin entry could not be safely removed. Uninstall stopped; other entries were not changed.');
  end;
  DeleteFile(AddBackslash(ProductRoot()) + 'plugin-registered.marker');
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    StopOrganizerService(VersionLauncherPath());
    UnregisterCodexPlugin();
    PurgeOrganizerData();
  end;
end;
