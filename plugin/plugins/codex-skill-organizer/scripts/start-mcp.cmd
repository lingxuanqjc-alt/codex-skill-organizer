@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "CSO_LAUNCHER=%LOCALAPPDATA%\Programs\SkillOrganizerForCodex\SkillOrganizerForCodex.exe"

if not exist "%CSO_LAUNCHER%" (
  1>&2 echo Skill Organizer for Codex is not installed or the stable launcher is missing.
  1>&2 echo Open the desktop installer and repair the installation. System PATH Node is never used.
  exit /b 78
)

"%CSO_LAUNCHER%" --mcp
exit /b %ERRORLEVEL%
