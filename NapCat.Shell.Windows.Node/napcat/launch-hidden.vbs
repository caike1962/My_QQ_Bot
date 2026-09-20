' Launches NapCat with a fully hidden console window.
' The scheduled task calls this instead of launcher-user.bat directly,
' so no console window appears on screen.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\QQBOT\NapCat.Shell.Windows.Node\napcat"
sh.Run "cmd.exe /c launcher-user.bat", 0, False
