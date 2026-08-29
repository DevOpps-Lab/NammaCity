-- How many faces were pixelated on the server before this photo was stored.
--
-- The app redacts on the device and the original never leaves the phone. A
-- WhatsApp photo has no browser in its path, so it used to be stored, mailed to
-- an authority and published on the public ledger with faces intact — disclosed
-- honestly, but disclosed is not the same as acceptable when the image is going
-- to a government office.
--
-- Faces are now pixelated server-side from the boxes the intake's existing
-- Gemini call returns. The count is carried between the photo message and the
-- location message so the complaint email can state what was actually done
-- rather than a blanket claim. Zero is a real answer and must be distinguishable
-- from "we never looked" — hence a default of 0 alongside the vision note.
alter table public.whatsapp_sessions
  add column if not exists faces_blurred integer not null default 0;
