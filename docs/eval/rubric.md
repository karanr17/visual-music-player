# Scene script rubric

The judge reads a song (title, artist, its lines with times, and the measured structure of the
music) and one scene script for it, written as the pictures a small pixel-art engine will draw
line by line. It scores four criteria from 1 to 10 and explains each score in one or two
sentences. The judge does not see which pipeline wrote the script.

Score what the engine will actually show. The script can only use a fixed vocabulary (17 settings,
about 55 subjects, a few motions, particles and one-shot events), so judge the choices within it,
not the vocabulary itself.

## 1. Fit to the lyrics (`fit`)

Do the pictures say what the song means?

- 9-10: The scenes follow the song's meaning and emotional arc, including subtext and metaphor.
  Concrete things the lyrics name appear when they are named. Who is on screen matches who the
  song is about. A listener would say "yes, that's this song".
- 6-8: Mostly right, with generic stretches (a lone figure standing in a field for lines that are
  about something specific) or a few literal readings of metaphors.
- 3-5: Pictures relate to the song's mood but rarely to its words; much of it could be any song.
- 1-2: Contradicts the song, or pictures metaphors literally in ways that undercut it.

## 2. Use of the musical structure (`structure`)

Does the script follow how the song is built?

- 9-10: Section changes line up with the song's parts. Instrumental stretches (intro, breaks,
  outro) get their own scenes rather than being covered by a sung section's picture. Parts that
  return (same structure letter, e.g. a chorus) come back to a recognisably related world, with
  variation in the moments. Quiet parts are calmer and loud parts carry the strongest images.
- 6-8: Mostly aligned, with one or two parts merged or a return that ignores its first occurrence.
- 3-5: Sections follow lyric lines only; repeats and instrumentals are not treated as such.
- 1-2: No relationship between the scenes and the song's structure.

## 3. Visual variety and direction (`variety`)

Is it a film, or a slideshow of one picture?

- 9-10: Shots vary like an editor's cut (establishing wides, mediums, closes saved for peaks).
  The worlds change with the song's development while keeping it one film (a motif or place that
  returns and changes). Subjects persist and move between lines instead of popping in and out.
  Transitions suit the change they make.
- 6-8: Some variety but long runs of the same shot or the same subjects, or worlds that change
  without reason.
- 3-5: Mostly one shot size and one or two subject choices repeated.
- 1-2: Static or random.

## 4. Renderability (`render`)

Will the engine draw this well?

- 9-10: Two to four subjects in most moments, focus marked where a line points at something,
  people used as people (couples for two people, a child only when there is one), positions that
  make sense (sky things in the sky). No invented things the engine can't draw, and few concepts
  left unmapped.
- 6-8: Occasional crowding (five subjects), empty moments where something should be seen, or odd
  placements.
- 3-5: Frequent empty or overcrowded moments, or subjects that contradict each other.
- 1-2: Mostly unrenderable.
