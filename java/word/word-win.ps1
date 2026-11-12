# zotlet's helper for Microsoft Word on Windows, run by zotlet as
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File word-win.ps1
# (Windows PowerShell 5.1, part of Windows 10/11; it has COM's GetActiveObject, PowerShell 7 does not).
#
# 1. It opens a hidden window of class "ZoteroMessageWindow": the Zotero template in Word (Zotero.dotm)
#    looks for that window and sends it the command of the button that was clicked (WM_COPYDATA).
#    Each command is written to stdout as {"event":"command","command":…,"document":…}.
# 2. It answers zotlet's document requests, one JSON line each on stdin ({ id, method, args }), with
#    { id, result } or { id, error } on stdout. The methods are the document RPCs of Zotero's
#    word-processor protocol, done through Word's COM object model as Zotero's Word for Windows
#    integration does (github.com/zotero/zotero-word-for-windows-integration, build/*/document.cpp, field.cpp).
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Zotlet {
    public static class Hub {
        // Lines for the PowerShell loop: "R" + request JSON (from stdin), "C" + command line (from Word), "Q" = stdin closed.
        public static readonly BlockingCollection<string> Queue = new BlockingCollection<string>();

        delegate IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct WNDCLASS {
            public uint style; public WndProc lpfnWndProc; public int cbClsExtra; public int cbWndExtra;
            public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground;
            public string lpszMenuName; public string lpszClassName;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct COPYDATASTRUCT { public IntPtr dwData; public int cbData; public IntPtr lpData; }

        [StructLayout(LayoutKind.Sequential)]
        struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern ushort RegisterClassW(ref WNDCLASS c);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateWindowExW(uint exStyle, string className, string windowName, uint style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
        [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] static extern int GetMessageW(out MSG msg, IntPtr hWnd, uint min, uint max);
        [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
        [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG msg);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowW(string className, string windowName);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);

        static WndProc keep; // the delegate must not be collected while the window lives
        public static string WindowError = null;

        static IntPtr Proc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam) {
            if (msg == 0x4A) { // WM_COPYDATA
                try {
                    COPYDATASTRUCT cds = (COPYDATASTRUCT) Marshal.PtrToStructure(lParam, typeof(COPYDATASTRUCT));
                    byte[] bytes = new byte[cds.cbData];
                    Marshal.Copy(cds.lpData, bytes, 0, cds.cbData);
                    // dwData 1: UTF-8 (the template's Zotero 6 path, used when this window is found); 2: UTF-16.
                    string text = cds.dwData.ToInt64() == 2 ? Encoding.Unicode.GetString(bytes) : Encoding.UTF8.GetString(bytes);
                    int nul = text.IndexOf('\0');
                    Queue.Add("C" + (nul >= 0 ? text.Substring(0, nul) : text));
                } catch (Exception e) {
                    Queue.Add("C!" + e.Message);
                }
                return new IntPtr(1);
            }
            return DefWindowProcW(hWnd, msg, wParam, lParam);
        }

        /** Open the hidden ZoteroMessageWindow on its own thread; false if one exists (Zotero 6, or another zotlet). */
        public static bool Listen() {
            if (FindWindowW("ZoteroMessageWindow", null) != IntPtr.Zero) return false;
            ManualResetEvent ready = new ManualResetEvent(false);
            Thread t = new Thread(() => {
                keep = new WndProc(Proc);
                WNDCLASS c = new WNDCLASS();
                c.lpfnWndProc = keep;
                c.hInstance = GetModuleHandleW(null);
                c.lpszClassName = "ZoteroMessageWindow";
                if (RegisterClassW(ref c) == 0) WindowError = "RegisterClass failed: " + Marshal.GetLastWin32Error();
                // A hidden top-level window (FindWindow does not see message-only windows).
                else if (CreateWindowExW(0, "ZoteroMessageWindow", "zotlet", 0, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, c.hInstance, IntPtr.Zero) == IntPtr.Zero)
                    WindowError = "CreateWindow failed: " + Marshal.GetLastWin32Error();
                ready.Set();
                if (WindowError != null) return;
                MSG m;
                while (GetMessageW(out m, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref m); DispatchMessageW(ref m); }
            });
            t.IsBackground = true;
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
            ready.WaitOne();
            return WindowError == null;
        }

        /** Read stdin on a thread of its own, so commands from Word are seen while no request is pending. */
        public static void ReadInput() {
            Thread t = new Thread(() => {
                string line;
                while ((line = Console.In.ReadLine()) != null) if (line.Trim().Length > 0) Queue.Add("R" + line);
                Queue.Add("Q");
            });
            t.IsBackground = true;
            t.Start();
        }

        /** A message box in front of Word. Returns the Win32 button id. */
        public static int Alert(string text, uint type) {
            return MessageBoxW(IntPtr.Zero, text, "zotlet", type | 0x40000u /* MB_TOPMOST */ | 0x10000u /* MB_SETFOREGROUND */);
        }
    }
}
'@

function Write-Line($obj) {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $obj -Compress -Depth 8))
    [Console]::Out.Flush()
}

# ---------- Word ----------

$script:word = $null
$script:doc = $null
$script:trackRevisions = $false
$script:codes = @{}
$Missing = [System.Reflection.Missing]::Value
$FieldPrefixes = @(' ADDIN ZOTERO_', ' CSL_')
$BookmarkPrefixes = @('ZOTERO_', 'CSL_')
$Placeholder = '{Citation}'

function Get-Word {
    try { return [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application') }
    catch { throw 'Microsoft Word is not running.' }
}

function Open-Document([string]$hint) {
    $script:word = Get-Word
    $found = $null
    if ($hint) {
        foreach ($d in $script:word.Documents) {
            if ($d.FullName -eq $hint -or $d.Name -eq $hint) { $found = $d; break }
        }
    }
    if (-not $found) { $found = $script:word.ActiveDocument }
    $script:doc = $found
    $script:trackRevisions = [bool]$found.TrackRevisions
    if ($script:trackRevisions) { $found.TrackRevisions = $false }
    try { $found.ActiveWindow.View.ShowFieldCodes = $false } catch {}
    return [string]$found.Name
}

function Get-Story([int]$story) {
    if ($story -eq 0) { return $script:doc.Content }
    try { return $script:doc.StoryRanges.Item($story + 1) } catch { return $null } # wdFootnotesStory 2, wdEndnotesStory 3
}

function Get-StoryFields([int]$story) {
    if ($story -eq 0) { return $script:doc.Fields }
    $range = Get-Story $story
    if ($range -eq $null) { return $null }
    return $range.Fields
}

function Get-Field([string]$id) {
    if ($id -notmatch '^F(\d):(\d+)$') { throw "Unknown field $id" }
    return (Get-StoryFields ([int]$Matches[1])).Item([int]$Matches[2])
}

function Strip-FieldCode([string]$raw) {
    foreach ($p in $FieldPrefixes) {
        $at = $raw.IndexOf($p)
        if ($at -ge 0) {
            $code = $raw.Substring($at + $p.Length)
            if ($code.EndsWith(' ')) { $code = $code.Substring(0, $code.Length - 1) }
            return $code
        }
    }
    return $null
}

function Strip-BookmarkCode([string]$raw) {
    foreach ($p in $BookmarkPrefixes) { if ($raw.StartsWith($p)) { return $raw.Substring($p.Length).TrimEnd(' ') } }
    return $null
}

# Document properties hold long values in chunks of 255 characters: NAME_1, NAME_2, …
function Get-Property([string]$name) {
    $props = $script:doc.CustomDocumentProperties
    $out = New-Object System.Text.StringBuilder
    for ($i = 1; ; $i++) {
        try {
            $p = [System.__ComObject].InvokeMember('Item', 'GetProperty', $null, $props, @("${name}_$i"))
            $v = [string][System.__ComObject].InvokeMember('Value', 'GetProperty', $null, $p, $null)
        } catch { break }
        if (-not $v) { break }
        [void]$out.Append($v)
    }
    return $out.ToString()
}

function Set-Property([string]$name, [string]$value) {
    $props = $script:doc.CustomDocumentProperties
    $n = [Math]::Ceiling($value.Length / 255)
    for ($i = 0; $i -lt $n; $i++) {
        $chunk = $value.Substring($i * 255, [Math]::Min(255, $value.Length - $i * 255))
        $key = "${name}_$($i + 1)"
        try {
            $p = [System.__ComObject].InvokeMember('Item', 'GetProperty', $null, $props, @($key))
            [void][System.__ComObject].InvokeMember('Value', 'SetProperty', $null, $p, @($chunk))
        } catch {
            # Add(Name, LinkToContent, Type = msoPropertyTypeString (4), Value)
            [void][System.__ComObject].InvokeMember('Add', 'InvokeMethod', $null, $props, @($key, $false, 4, $chunk))
        }
    }
    for ($i = $n + 1; ; $i++) {
        try {
            $p = [System.__ComObject].InvokeMember('Item', 'GetProperty', $null, $props, @("${name}_$i"))
            [void][System.__ComObject].InvokeMember('Delete', 'InvokeMethod', $null, $p, $null)
        } catch { break }
    }
}

function New-List { return New-Object System.Collections.ArrayList }

function Get-Fields([string]$fieldType) {
    $rows = New-List
    if ($fieldType -eq 'Bookmark') {
        foreach ($b in $script:doc.Bookmarks) {
            if (-not $b.Name.StartsWith('ZOTERO_')) { continue }
            $code = Strip-BookmarkCode (Get-Property $b.Name)
            if ($code -ne $null) { [void]$rows.Add([pscustomobject]@{ id = "B:$($b.Name)"; code = $code; pos = $b.Range.Start; notePos = 0; note = 0 }) }
        }
    } else {
        foreach ($story in 0, 1, 2) {
            $fields = Get-StoryFields $story
            if ($fields -eq $null) { continue }
            for ($i = 1; $i -le $fields.Count; $i++) {
                $f = $fields.Item($i)
                $code = Strip-FieldCode ([string]$f.Code.Text)
                if ($code -eq $null) { continue }
                $pos = $f.Code.Start
                if ($story -eq 1) { try { $pos = $f.Result.Footnotes.Item(1).Reference.Start } catch {} }
                if ($story -eq 2) { try { $pos = $f.Result.Endnotes.Item(1).Reference.Start } catch {} }
                [void]$rows.Add([pscustomobject]@{ id = "F${story}:$i"; code = $code; pos = $pos; notePos = $(if ($story) { $f.Code.Start } else { 0 }); note = $story })
            }
        }
    }
    $sorted = @($rows | Sort-Object pos, notePos)
    $ids = New-List; $codes = New-List; $notes = New-List
    foreach ($r in $sorted) {
        [void]$ids.Add($r.id); [void]$codes.Add($r.code); [void]$notes.Add($(if ($r.note) { 1 } else { 0 }))
        $script:codes[$r.id] = $r.code
    }
    return @(, @($ids.ToArray(), $codes.ToArray(), $notes.ToArray()))
}

function Get-CursorField([string]$fieldType) {
    $sel = $script:doc.ActiveWindow.Selection
    $s = $sel.Start; $e = $sel.End
    if ($fieldType -eq 'Bookmark') {
        foreach ($b in $sel.Bookmarks) {
            if (-not $b.Name.StartsWith('ZOTERO_')) { continue }
            $code = Strip-BookmarkCode (Get-Property $b.Name)
            if ($code -ne $null) { $script:codes["B:$($b.Name)"] = $code; return @(, @("B:$($b.Name)", $code, 0)) }
        }
        return $null
    }
    $type = $sel.StoryType
    $story = $(if ($type -eq 2) { 1 } elseif ($type -eq 3) { 2 } else { 0 })
    $fields = Get-StoryFields $story
    if ($fields -eq $null) { return $null }
    for ($i = 1; $i -le $fields.Count; $i++) {
        $f = $fields.Item($i)
        $codeStart = $f.Code.Start - 1
        $resultEnd = $f.Result.End + 1
        if ($s -le $resultEnd -and $e -ge $codeStart) {
            $code = Strip-FieldCode ([string]$f.Code.Text)
            if ($code -ne $null) { $script:codes["F${story}:$i"] = $code; return @(, @("F${story}:$i", $code, $(if ($story) { 1 } else { 0 }))) }
        }
        if ($codeStart -gt $e) { break }
    }
    return $null
}

function Add-Field([string]$fieldType) {
    $sel = $script:doc.ActiveWindow.Selection
    $where = $sel.Range
    if ($fieldType -eq 'Bookmark') {
        $where.Text = $Placeholder
        $name = 'ZOTERO_BREF_' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
        [void]$script:doc.Bookmarks.Add($name, $where)
        return @(, @("B:$name", '', 0))
    }
    $type = $where.StoryType
    $story = $(if ($type -eq 2) { 1 } elseif ($type -eq 3) { 2 } else { 0 })
    # Like Zotero: a QUOTE field (wdFieldQuote = 35) holding the placeholder; its code is replaced next.
    $field = $script:doc.Fields.Add($where, 35, $Placeholder, $true)
    $start = $field.Code.Start
    $field.Code.Text = ' ADDIN ZOTERO_TEMP '
    $fields = Get-StoryFields $story
    for ($i = 1; $i -le $fields.Count; $i++) {
        if ($fields.Item($i).Code.Start -eq $start) { $script:codes["F${story}:$i"] = 'TEMP'; return @(, @("F${story}:$i", 'TEMP', $(if ($story) { 1 } else { 0 }))) }
    }
    throw 'The new field could not be found'
}

function Insert-RTF($range, [string]$rtf) {
    $path = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'zotlet-' + [Guid]::NewGuid().ToString('N') + '.rtf')
    [IO.File]::WriteAllText($path, $rtf, (New-Object System.Text.UTF8Encoding $false))
    try { [void]$range.InsertFile($path, $Missing, $false, $false, $false) }
    finally { Remove-Item -LiteralPath $path -ErrorAction SilentlyContinue }
}

function Set-BibliographyStyle($range) {
    try { $range.Style = -266 } catch { try { $range.Style = 'Bibliography' } catch {} } # wdStyleBibliography
}

function Set-Text([string]$id, [string]$text, [bool]$isRich) {
    $bookmark = $null
    if ($id.StartsWith('B:')) { $bookmark = $script:doc.Bookmarks.Item($id.Substring(2)); $range = $bookmark.Range; $field = $null }
    else { $field = Get-Field $id; $range = $field.Result }
    $fontName = $range.Font.Name
    $fontSize = $range.Font.Size
    if (-not $fontName) { try { $fontName = $range.Style.Font.Name } catch {} }
    if ($isRich) {
        if ($bookmark -ne $null -and $text.Length -gt 6) {
            # InsertFile would remove the bookmark: put it into the RTF itself (as Zotero does).
            $name = $bookmark.Name
            Insert-RTF $range ('{\rtf {\bkmkstart ' + $name + '}{' + $text.Substring(6) + '{\bkmkend ' + $name + '}}')
            $range = $script:doc.Bookmarks.Item($name).Range
        } else {
            # In Word 2013 and later, text inserted into an empty field result does not land inside it.
            $range.Text = '  '
            $toDelete = $range.Duplicate; [void]$toDelete.Collapse(0)
            $dup = $range.Duplicate; [void]$dup.MoveEnd(1, -1)
            Insert-RTF $dup $text
            [void]$toDelete.MoveStart(1, -1); $toDelete.Text = ''
            $range = $field.Result
        }
        if ($fontName) { $range.Font.Name = $fontName }
        if ($fontSize -gt 0 -and $fontSize -lt 1000) { $range.Font.Size = $fontSize }
        # InsertFile adds a paragraph mark at the end; remove it unless the text has paragraphs.
        if ($text -notmatch '\\par|\\\r|\\\n') {
            $end = $range.Duplicate; [void]$end.Collapse(0); [void]$end.MoveStart(1, -1)
            if ($end.Text -ne "`r") { [void]$end.Collapse(0); [void]$end.MoveEnd(1, 1) }
            if ($end.Text -eq "`r") { $end.Text = '' }
        }
        if (($script:codes[$id] + '') -like 'BIBL*') { Set-BibliographyStyle $range }
    } else {
        $range.Font.Reset()
        $range.Text = $text
        if ($bookmark -ne $null) { [void]$script:doc.Bookmarks.Add($bookmark.Name, $range) }
        if ($fontName) { $range.Font.Name = $fontName }
        if ($fontSize -gt 0 -and $fontSize -lt 1000) { $range.Font.Size = $fontSize }
    }
}

function Set-Code([string]$id, [string]$code) {
    $script:codes[$id] = $code
    if ($id.StartsWith('B:')) { Set-Property $id.Substring(2) ('ZOTERO_' + $code) }
    else { (Get-Field $id).Code.Text = ' ADDIN ZOTERO_' + $code + ' ' }
}

function Remove-Code([string]$id) {
    if ($id.StartsWith('B:')) {
        $name = $id.Substring(2)
        try { $script:doc.Bookmarks.Item($name).Delete() } catch {}
        Set-Property $name ''
    } else { (Get-Field $id).Unlink() }
}

function Set-BibliographyParagraphs($first, $body, $lineSpacing, $entrySpacing, $tabs) {
    $styles = $script:doc.Styles
    $style = $null
    try { $style = $styles.Item(-266) } catch { try { $style = $styles.Item('Bibliography') } catch { $style = $styles.Add('Bibliography', 1) } }
    $pf = $style.ParagraphFormat
    $pf.FirstLineIndent = [double]$first / 20
    $pf.LeftIndent = [double]$body / 20
    $pf.LineSpacing = [double]$lineSpacing / 20
    $pf.SpaceAfter = [double]$entrySpacing / 20
    $pf.TabStops.ClearAll()
    foreach ($t in @($tabs)) { if ($t -ne $null) { [void]$pf.TabStops.Add([double]$t / 20, 0, 0) } }
}

function Show-Alert([string]$text, [int]$icon, [int]$buttons) {
    $iconFlag = @(0x10, 0x40, 0x30)[[Math]::Max(0, [Math]::Min(2, $icon))]
    $buttonFlag = @(0, 1, 4, 3)[[Math]::Max(0, [Math]::Min(3, $buttons))] # OK, OKCANCEL, YESNO, YESNOCANCEL
    $answer = [Zotlet.Hub]::Alert($text, [uint32]($iconFlag -bor $buttonFlag))
    # Same numbering as Zotero: the index of the button in (Cancel, No, Yes) / (Cancel, OK) / (No, Yes).
    switch ($buttons) {
        1 { return $(if ($answer -eq 1) { 1 } else { 0 }) }
        2 { return $(if ($answer -eq 6) { 1 } else { 0 }) }
        3 { return $(if ($answer -eq 6) { 2 } elseif ($answer -eq 7) { 1 } else { 0 }) }
        default { return 0 }
    }
}

function Complete-Document {
    if ($script:doc -ne $null -and $script:trackRevisions) { try { $script:doc.TrackRevisions = $true } catch {} }
    $script:trackRevisions = $false
}

function Invoke-Request($request) {
    $a = @($request.args)
    switch ($request.method) {
        'init' { return Open-Document ([string]$a[0]) }
        'Document.getDocumentData' { return Get-Property 'ZOTERO_PREF' }
        'Document.setDocumentData' { Set-Property 'ZOTERO_PREF' ([string]$a[0]); return $null }
        'Document.cursorInField' { return Get-CursorField ([string]$a[0]) }
        'Document.insertField' { return Add-Field ([string]$a[0]) }
        'Document.getFields' { return Get-Fields ([string]$a[0]) }
        'Document.setBibliographyStyle' { Set-BibliographyParagraphs $a[0] $a[1] $a[2] $a[3] $a[4]; return $null }
        'Document.displayAlert' { return Show-Alert ([string]$a[0]) ([int]$a[1]) ([int]$a[2]) }
        'Document.activate' { try { $script:word.Activate() } catch {}; return $null }
        'Document.complete' { Complete-Document; return $null }
        'Field.setText' { Set-Text ([string]$a[0]) ([string]$a[1]) ([bool]$a[2]); return $null }
        'Field.getText' { if (([string]$a[0]).StartsWith('B:')) { return [string]$script:doc.Bookmarks.Item(([string]$a[0]).Substring(2)).Range.Text } else { return [string](Get-Field ([string]$a[0])).Result.Text } }
        'Field.setCode' { Set-Code ([string]$a[0]) ([string]$a[1]); return $null }
        'Field.removeCode' { Remove-Code ([string]$a[0]); return $null }
        'Field.delete' { if (([string]$a[0]).StartsWith('B:')) { $script:doc.Bookmarks.Item(([string]$a[0]).Substring(2)).Range.Text = '' } else { (Get-Field ([string]$a[0])).Delete() }; return $null }
        'Field.select' { if (([string]$a[0]).StartsWith('B:')) { $script:doc.Bookmarks.Item(([string]$a[0]).Substring(2)).Range.Select() } else { (Get-Field ([string]$a[0])).Result.Select() }; return $null }
        default { throw "Unknown method $($request.method)" }
    }
}

# "zotero.exe -silent -ZoteroIntegrationAgent WinWord -ZoteroIntegrationCommand addEditCitation -ZoteroIntegrationDocument "C:\x.docx" …"
function Parse-Command([string]$line) {
    $command = if ($line -match '-ZoteroIntegrationCommand\s+(\S+)') { $Matches[1] } else { '' }
    $document = if ($line -match '-ZoteroIntegrationDocument\s+"((?:[^"]|"")*)"') { $Matches[1].Replace('""', '"') } else { '' }
    return @{ event = 'command'; command = $command; document = $document }
}

# ---------- main loop ----------

$listening = [Zotlet.Hub]::Listen()
if ($listening) { Write-Line @{ event = 'ready' } }
else { Write-Line @{ event = 'ready'; warning = $(if ([Zotlet.Hub]::WindowError) { [Zotlet.Hub]::WindowError } else { 'Another program (Zotero?) already answers the Word plugin.' }) } }
[Zotlet.Hub]::ReadInput()

while ($true) {
    $item = [Zotlet.Hub]::Queue.Take()
    if ($item -eq 'Q') { break }
    if ($item.StartsWith('C')) {
        Write-Line (Parse-Command $item.Substring(1))
        continue
    }
    $request = $null
    try { $request = ConvertFrom-Json $item.Substring(1) } catch { continue }
    try {
        $result = Invoke-Request $request
        Write-Line @{ id = $request.id; result = $result }
    } catch {
        Write-Line @{ id = $request.id; error = [string]$_.Exception.Message }
    }
}
