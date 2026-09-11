import asyncio
import os
import sounddevice as sd

from google import genai
from google.genai import types


MODEL = "gemini-3.1-flash-live-preview"

INPUT_RATE = 16000
OUTPUT_RATE = 24000
RECORD_SECONDS = 5


async def main():
    if not os.getenv("GEMINI_API_KEY"):
        raise RuntimeError("GEMINI_API_KEY is not set")

    client = genai.Client()

    config = {
        "response_modalities": ["AUDIO"],
        "input_audio_transcription": {},
        "output_audio_transcription": {},
    }

    print(f"🎤 Speak for {RECORD_SECONDS} seconds...")

    # Record raw 16-bit PCM mono audio
    recording = sd.rec(
        int(RECORD_SECONDS * INPUT_RATE),
        samplerate=INPUT_RATE,
        channels=1,
        dtype="int16",
    )

    sd.wait()

    audio_bytes = recording.tobytes()

    print("✅ Recording complete")
    print("🔗 Connecting to Gemini Live...")

    async with client.aio.live.connect(
        model=MODEL,
        config=config,
    ) as session:

        print("✅ Connected")

        # Send audio in ~100 ms chunks
        bytes_per_chunk = int(INPUT_RATE * 0.1) * 2

        for i in range(0, len(audio_bytes), bytes_per_chunk):
            chunk = audio_bytes[i:i + bytes_per_chunk]

            await session.send_realtime_input(
                audio=types.Blob(
                    data=chunk,
                    mime_type="audio/pcm;rate=16000",
                )
            )

        # Tell Gemini the microphone stream has ended
        await session.send_realtime_input(
            audio_stream_end=True
        )

        print("\n🤖 Gemini:")

        # Gemini audio output is 24 kHz PCM
        with sd.RawOutputStream(
            samplerate=OUTPUT_RATE,
            channels=1,
            dtype="int16",
        ) as output_stream:

            async for response in session.receive():

                content = response.server_content

                if not content:
                    continue

                # What Gemini heard from you
                if content.input_transcription:
                    text = content.input_transcription.text
                    if text:
                        print(f"\nYou: {text}")

                # Transcript of Gemini's spoken response
                if content.output_transcription:
                    text = content.output_transcription.text
                    if text:
                        print(text, end="", flush=True)

                # Play Gemini native voice immediately
                if content.model_turn:
                    for part in content.model_turn.parts:
                        if part.inline_data and part.inline_data.data:
                            output_stream.write(
                                part.inline_data.data
                            )

                if content.turn_complete:
                    break

    await client.aio.aclose()

    print("\n\n✅ Finished")


if __name__ == "__main__":
    asyncio.run(main())
