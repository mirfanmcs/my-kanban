' Double-click this file to stop the Kanban dashboard server and free port 9000.
' It finds whichever process is listening on that port and force-stops it,
' so you can safely restart the server (e.g. via Start Kanban.vbs) afterwards.

Set shell = CreateObject("WScript.Shell")

portToFree = "9000"
foundAny = False

Set exec = shell.Exec("cmd /c netstat -ano | findstr "":" & portToFree & """ | findstr LISTENING")
Do While Not exec.StdOut.AtEndOfStream
    line = Trim(exec.StdOut.ReadLine())
    If Len(line) > 0 Then
        parts = Split(line, " ")
        pid = ""
        For i = 0 To UBound(parts)
            If Len(Trim(parts(i))) > 0 Then pid = Trim(parts(i))
        Next
        If pid <> "" And IsNumeric(pid) Then
            shell.Run "cmd /c taskkill /PID " & pid & " /F", 0, True
            foundAny = True
        End If
    End If
Loop

If foundAny Then
    MsgBox "Kanban server stopped and port " & portToFree & " freed.", 64, "Stop Kanban"
Else
    MsgBox "No Kanban server was found running on port " & portToFree & ".", 64, "Stop Kanban"
End If
