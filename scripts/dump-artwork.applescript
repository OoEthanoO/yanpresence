-- Writes the current track's embedded artwork to the path given as argv 1 and
-- prints the image format on stdout. Used only for local library files that
-- Apple's catalog does not have, so there is no CDN URL to point Discord at.
on run argv
	set outPath to item 1 of argv

	if application "Music" is not running then error "Music is not running"

	tell application "Music"
		set t to current track
		if (count of artworks of t) is 0 then error "current track has no artwork"
		set a to artwork 1 of t
		set imgFormat to "unknown"
		try
			set imgFormat to (format of a) as text
		end try
		set imgData to raw data of a
	end tell

	set fh to open for access (POSIX file outPath) with write permission
	try
		set eof fh to 0
		write imgData to fh
		close access fh
	on error errMsg
		try
			close access fh
		end try
		error errMsg
	end try

	return imgFormat
end run
