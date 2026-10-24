@echo off
rem Zen-Dock CLI wrapper.
rem Keep this file ASCII-only: cmd.exe reads .cmd files using the OEM code page
rem (936 on Chinese Windows), so UTF-8 Chinese comments turn into garbage and
rem break parsing. Chinese output comes from Node, which uses WriteConsoleW.
node "%~dp0bin\zd.mjs" %*
