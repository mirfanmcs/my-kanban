' Double-click this file to launch the Kanban dashboard.
' It silently starts the local server (no console window) and opens your
' default browser to the board. Data is saved automatically to data\kanban-data.json
' and the app code lives in the src\ folder.

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

folder = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = folder

' Start the server hidden (window style 0 = hidden), don't wait for it to exit.
' If it's already running, this will simply fail silently and we still open the browser.
On Error Resume Next
shell.Run "cmd /c node src\server.js", 0, False
On Error Goto 0

' Give the server a moment to start listening.
WScript.Sleep 1200

shell.Run "http://localhost:9000"
