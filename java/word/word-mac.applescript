-- Word's AppleScript dictionary, without JavaScript for Automation or an ObjC bridge.
-- WordMac.java appends one handler call and runs this source through ordinary osascript.
-- Every operation resolves the document captured before the citation picker opened.
using terms from application "Microsoft Word"

on zDocument(zName, zPath)
  tell application id "com.microsoft.Word"
    set zMatches to every document whose name is zName
    if (count of zMatches) is not 1 then error "The Word document is closed, renamed, or ambiguous. Click the Word button again."
    set zDoc to item 1 of zMatches
    if (full name of zDoc as text) is not zPath then error "The Word document has changed. Click the Word button again."
    return zDoc
  end tell
end zDocument

on zInit()
  tell application id "com.microsoft.Word"
    if (count of documents) is 0 then error "Open a document in Microsoft Word first."
    set zDoc to active document
    set zName to name of zDoc
    set zPath to full name of zDoc as text
    set zDoc to my zDocument(zName, zPath)
    set zTrack to track revisions of zDoc
    set zView to view of active window of zDoc
    set zCodes to show field codes of zView
    set zRevisions to show insertions and deletions of zView
    set zFormat to show format changes of zView
    set zKind to my zStoryKind(story type of selection)
    return {zName, zPath, zTrack, zCodes, zRevisions, zFormat, zKind, selection start of selection, selection end of selection}
  end tell
end zInit

on zBegin(zName, zPath)
  tell application id "com.microsoft.Word"
    set zDoc to my zDocument(zName, zPath)
    set track revisions of zDoc to false
    set show field codes of view of active window of zDoc to false
  end tell
  return missing value
end zBegin

on zComplete(zName, zPath, zTrack, zCodes, zRevisions, zFormat)
  tell application id "com.microsoft.Word"
    set zDoc to my zDocument(zName, zPath)
    set track revisions of zDoc to zTrack
    set zView to view of active window of zDoc
    set show field codes of zView to zCodes
    set show insertions and deletions of zView to zRevisions
    set show format changes of zView to zFormat
  end tell
  return missing value
end zComplete

on zPrepare(zName, zPath)
  tell application id "com.microsoft.Word"
    set zDoc to my zDocument(zName, zPath)
    set zView to view of active window of zDoc
    set show insertions and deletions of zView to false
    set show format changes of zView to false
  end tell
  return missing value
end zPrepare

on zGetProperty(zName, zPath, zKey)
  tell application id "com.microsoft.Word"
    set zDoc to my zDocument(zName, zPath)
    set zOut to ""
    set zIndex to 1
    repeat
      set zProps to every custom document property of zDoc whose name is (zKey & "_" & zIndex)
      if (count of zProps) is 0 then exit repeat
      set zValue to value of item 1 of zProps
      if zValue is missing value or zValue is "" then exit repeat
      set zOut to zOut & zValue
      set zIndex to zIndex + 1
    end repeat
    return zOut
  end tell
end zGetProperty

on zSetProperty(zName, zPath, zKey, zChunks)
  tell application id "com.microsoft.Word"
    set zDoc to my zDocument(zName, zPath)
    set zIndex to 0
    repeat with zChunk in zChunks
      set zIndex to zIndex + 1
      set zPropName to zKey & "_" & zIndex
      if exists custom document property zPropName of zDoc then
        set value of custom document property zPropName of zDoc to contents of zChunk
      else
        make new custom document property at zDoc with properties {name:zPropName, value:contents of zChunk}
      end if
    end repeat
    -- Remove all obsolete chunks, including gaps left by another editor.
    set zProps to every custom document property of zDoc
    repeat with zIndex from (count of zProps) to 1 by -1
      set zProp to item zIndex of zProps
      set zPropName to name of zProp
      if zPropName starts with (zKey & "_") then
        set zSuffix to text ((length of zKey) + 2) thru -1 of zPropName
        set zNumber to 0
        try
          set zNumber to zSuffix as integer
        end try
        if zNumber > (count of zChunks) then delete zProp
      end if
    end repeat
  end tell
  return missing value
end zSetProperty

on zStoryKind(zType)
  if zType is main text story then return 0
  if zType is footnotes story then return 1
  if zType is endnotes story then return 2
  error "Place the cursor in the document text, a footnote, or an endnote."
end zStoryKind

on zGetStory(zDoc, zKind)
  tell application id "com.microsoft.Word"
    if zKind is 0 then return zDoc
    if zKind is 1 then return get story range zDoc story type footnotes story
    if zKind is 2 then return get story range zDoc story type endnotes story
    error "Unknown Word story"
  end tell
end zGetStory

on zStoryFields(zName, zPath, zKind)
  tell application id "com.microsoft.Word"
    set zDoc to my zDocument(zName, zPath)
    set zOut to {}
    try
      set zStory to my zGetStory(zDoc, zKind)
      set zCount to count of fields of zStory
    on error zError number zNumber
      if zKind is not 0 and zNumber is -1728 then return zOut
      error zError number zNumber
    end try
    repeat with zIndex from 1 to zCount
      set zField to field zIndex of zStory
      set zCode to content of field code of zField
      if zCode is not missing value and (zCode contains " ADDIN ZOTERO_" or zCode contains " CSL_") then
        set zStart to start of content of field code of zField
        set zPos to zStart
        try
          if zKind is 1 then set zPos to start of content of note reference of (footnote 1 of (result range of zField))
          if zKind is 2 then set zPos to start of content of note reference of (endnote 1 of (result range of zField))
        end try
        set end of zOut to {zIndex, zCode, zPos, zStart}
      end if
    end repeat
    return zOut
  end tell
end zStoryFields

on zBookmarks(zName, zPath)
  tell application id "com.microsoft.Word"
    set zDoc to my zDocument(zName, zPath)
    set zOut to {}
    repeat with zMark in bookmarks of zDoc
      set zMarkName to name of zMark
      if zMarkName starts with "ZOTERO_" then set end of zOut to {zMarkName, start of bookmark of zMark}
    end repeat
    return zOut
  end tell
end zBookmarks

-- Recreate the selection that existed before the picker; never use another document's cursor.
on zSelectOriginal(zDoc, zKind, zStart, zEnd)
  tell application id "com.microsoft.Word"
    activate object zDoc
    if zKind is 0 then
      set zRange to create range zDoc start zStart end zEnd
    else
      set zRange to my zGetStory(zDoc, zKind)
      -- Word's start/end of content properties are read-only. Selection endpoints are writable.
      select zRange
      set selection start of selection to zStart
      set selection end of selection to zEnd
      set zRange to text object of selection
    end if
    select zRange
    return zRange
  end tell
end zSelectOriginal

on zCursor(zName, zPath, zKind, zStart, zEnd)
  tell application id "com.microsoft.Word"
    set zDoc to my zDocument(zName, zPath)
    set zStory to my zGetStory(zDoc, zKind)
    repeat with zIndex from 1 to (count of fields of zStory)
      set zField to field zIndex of zStory
      set zCodeStart to (start of content of field code of zField) - 1
      set zResultEnd to (end of content of result range of zField) + 1
      if zStart ≤ zResultEnd and zEnd ≥ zCodeStart then
        set zCode to content of field code of zField
        if zCode contains " ADDIN ZOTERO_" or zCode contains " CSL_" then return {zIndex, zCode}
      end if
      if zCodeStart > zEnd then exit repeat
    end repeat
    return {}
  end tell
end zCursor

on zCursorBookmark(zName, zPath, zStart, zEnd)
  tell application id "com.microsoft.Word"
    set zDoc to my zDocument(zName, zPath)
    repeat with zMark in bookmarks of zDoc
      set zMarkName to name of zMark
      if zMarkName starts with "ZOTERO_" and (start of bookmark of zMark) ≤ zEnd and (end of bookmark of zMark) ≥ zStart then return zMarkName
    end repeat
    return ""
  end tell
end zCursorBookmark

on zInsert(zName, zPath, zKind, zStart, zEnd)
  tell application id "com.microsoft.Word"
    set zDoc to my zDocument(zName, zPath)
    set zWhere to my zSelectOriginal(zDoc, zKind, zStart, zEnd)
    make new field at zWhere with properties {field type:field print date}
    set zStory to my zGetStory(zDoc, zKind)
    set zBest to 0
    set zBestDistance to 1000000
    repeat with zIndex from 1 to (count of fields of zStory)
      set zCodeStart to start of content of field code of field zIndex of zStory
      set zDistance to zCodeStart - zStart
      if zDistance < 0 then set zDistance to -zDistance
      if zDistance < zBestDistance then
        set zBest to zIndex
        set zBestDistance to zDistance
      end if
      if zCodeStart > zStart + 2 then exit repeat
    end repeat
    if zBest is 0 then error "The new Word field could not be found"
    set content of result range of field zBest of zStory to "{Citation}"
    set content of field code of field zBest of zStory to " ADDIN ZOTERO_TEMP "
    return zBest
  end tell
end zInsert

on zInsertBookmark(zName, zPath, zMarkName, zStart, zEnd)
  tell application id "com.microsoft.Word"
    set zDoc to my zDocument(zName, zPath)
    set zWhere to my zSelectOriginal(zDoc, 0, zStart, zEnd)
    set content of zWhere to "{Citation}"
    set zRange to create range zDoc start zStart end (zStart + 10)
    make new bookmark at zRange with properties {name:zMarkName}
  end tell
  return missing value
end zInsertBookmark

on zGetField(zDoc, zKind, zIndex)
  tell application id "com.microsoft.Word"
    return field zIndex of (my zGetStory(zDoc, zKind))
  end tell
end zGetField

on zGetRange(zDoc, zKind, zIndex, zMarkName)
  tell application id "com.microsoft.Word"
    if zMarkName is not "" then return text object of bookmark zMarkName of zDoc
    return result range of (my zGetField(zDoc, zKind, zIndex))
  end tell
end zGetRange

on zSetCode(zName, zPath, zKind, zIndex, zCode)
  tell application id "com.microsoft.Word"
    set zDoc to my zDocument(zName, zPath)
    set content of field code of (my zGetField(zDoc, zKind, zIndex)) to zCode
  end tell
  return missing value
end zSetCode

on zRemove(zName, zPath, zKind, zIndex, zMarkName, zDelete)
  tell application id "com.microsoft.Word"
    set zDoc to my zDocument(zName, zPath)
    if zMarkName is not "" then
      if zDelete then set content of text object of bookmark zMarkName of zDoc to ""
      if exists bookmark zMarkName of zDoc then delete bookmark zMarkName of zDoc
    else
      set zField to my zGetField(zDoc, zKind, zIndex)
      if zDelete then
        delete zField
      else
        «event sWRD2489» zField
      end if
    end if
  end tell
  return missing value
end zRemove

on zGetText(zName, zPath, zKind, zIndex, zMarkName)
  tell application id "com.microsoft.Word"
    set zDoc to my zDocument(zName, zPath)
    return content of (my zGetRange(zDoc, zKind, zIndex, zMarkName))
  end tell
end zGetText

on zSelect(zName, zPath, zKind, zIndex, zMarkName)
  tell application id "com.microsoft.Word"
    set zDoc to my zDocument(zName, zPath)
    activate object zDoc
    select (my zGetRange(zDoc, zKind, zIndex, zMarkName))
  end tell
  return missing value
end zSelect

-- A single AppleScript invocation owns the clipboard transaction. Both error and success paths
-- restore the original clipboard record and Word's smart-paste setting before returning to Java.
on zSetText(zName, zPath, zKind, zIndex, zMarkName, zText, zRich, zBibliography)
  tell application id "com.microsoft.Word"
    set zDoc to my zDocument(zName, zPath)
    set zRange to my zGetRange(zDoc, zKind, zIndex, zMarkName)
    if zMarkName is not "" then
      set zStart to start of bookmark of bookmark zMarkName of zDoc
      set zEnd to end of bookmark of bookmark zMarkName of zDoc
      set zStoryEnd to end of content of text object of zDoc
    end if
    if zRich then
      set zFontName to ""
      set zFontSize to 0
      try
        set zFontName to name of font object of zRange
        set zFontSize to font size of font object of zRange
      end try
      set zAdjust to paste adjust word spacing of settings
    end if
  end tell
  if zRich then
    -- Read the clipboard before changing anything; if it cannot be saved, leave it alone.
    if (clipboard info) is {} then
      set zSavedClipboard to ""
    else
      set zSavedClipboard to the clipboard as record
    end if
    try
      set the clipboard to {«class RTF »:zText}
      tell application id "com.microsoft.Word"
        set paste adjust word spacing of settings to false
        paste object zRange
      end tell
    on error zError number zNumber
      try
        tell application id "com.microsoft.Word" to set paste adjust word spacing of settings to zAdjust
      end try
      set the clipboard to zSavedClipboard
      error zError number zNumber
    end try
    -- Restore the clipboard even if restoring Word's paste setting fails.
    try
      tell application id "com.microsoft.Word" to set paste adjust word spacing of settings to zAdjust
    on error zError number zNumber
      set the clipboard to zSavedClipboard
      error zError number zNumber
    end try
    set the clipboard to zSavedClipboard
  else
    tell application id "com.microsoft.Word"
      try
        set superscript of font object of zRange to false
      end try
      set content of zRange to zText
    end tell
  end if
  tell application id "com.microsoft.Word"
    if zMarkName is not "" then
      set zNewEnd to zEnd + (end of content of text object of zDoc) - zStoryEnd
      if exists bookmark zMarkName of zDoc then delete bookmark zMarkName of zDoc
      set zRange to create range zDoc start zStart end zNewEnd
      make new bookmark at zRange with properties {name:zMarkName}
    else
      set zRange to my zGetRange(zDoc, zKind, zIndex, zMarkName)
    end if
    if zRich then
      if zBibliography then
        try
          set style of zRange to style bibliography
        end try
      end if
      try
        if zFontName is not missing value and zFontName is not "" then set name of font object of zRange to zFontName
        if zFontSize is not missing value and zFontSize > 0 then set font size of font object of zRange to zFontSize
      end try
    end if
  end tell
  return missing value
end zSetText

on zBibliographyStyle(zName, zPath, zFirst, zBody, zLine, zEntry, zTabs)
  tell application id "com.microsoft.Word"
    set zDoc to my zDocument(zName, zPath)
    try
      set zStyle to Word style style bibliography of zDoc
      get name local of zStyle
    on error
      try
        set zStyle to Word style "Bibliography" of zDoc
        get name local of zStyle
      on error
        set zStyle to make new Word style at zDoc with properties {name local:"Bibliography", style type:style type paragraph, base style:style normal}
      end try
    end try
    set zFormat to paragraph format of zStyle
    try
      delete every tab stop of zFormat
    end try
    set first line indent of zFormat to zFirst
    set paragraph format left indent of zFormat to zBody
    set line spacing of zFormat to zLine
    set space after of zFormat to zEntry
    repeat with zTab in zTabs
      make new tab stop at zFormat with properties {alignment:align tab left, tab leader:tab leader spaces, tab stop position:contents of zTab}
    end repeat
  end tell
  return missing value
end zBibliographyStyle

on zAlert(zName, zPath, zText, zIcon, zButtons)
  tell application id "com.microsoft.Word"
    set zDoc to my zDocument(zName, zPath)
    activate object zDoc
    activate
    set zAnswer to display alert zText as zIcon buttons zButtons default button (item -1 of zButtons)
    return button returned of zAnswer
  end tell
end zAlert

on zActivate(zName, zPath)
  tell application id "com.microsoft.Word"
    set zDoc to my zDocument(zName, zPath)
    activate object zDoc
    activate
  end tell
  return missing value
end zActivate

end using terms from
