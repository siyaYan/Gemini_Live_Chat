import asyncio
import os
import sounddevice as sd

from google import genai
from google.genai import types


MODEL = "gemini-3.1-flash-live-preview"

INPUT_RATE = 16000
OUTPUT_RATE = 24000

# 40 ms microphone chunks
BLOCK_SIZE = 640


async def main():
    if not os.getenv("GEMINI_API_KEY"):
        raise RuntimeError("GEMINI_API_KEY is not set")

    client = genai.Client()

    config = {
        "response_modalities": ["AUDIO"],
        "input_audio_transcription": {},
        "output_audio_transcription": {},
        "system_instruction": (
            "You are a natural conversational voice assistant. "
            "Keep responses reasonably concise unless the user asks for detail."
        ),
    }

    audio_queue = asyncio.Queue(maxsize=50)
    loop = asyncio.get_running_loop()

    print("Connecting to Gemini Live...")

    async with client.aio.live.connect(
        model=MODEL,
        config=config,
    ) as session:

        print("✅ Connected")
        print("🎤 Continuous conversation started")
        print("Speak naturally. Press Ctrl+C to stop.\n")

        # sounddevice callback runs outside asyncio,
        # so feed microphone data safely into the async queue.
        def mic_callback(indata, frames, time, status):
            if status:
                print(f"\nMic status: {status}")

            audio_bytes = bytes(indata)

            def add_to_queue():
                if not audio_queue.full():
                    audio_queue.put_nowait(audio_bytes)

            loop.call_soon_threadsafe(add_to_queue)

        async def send_audio():
            while True:
                chunk = await audio_queue.get()

                await session.send_realtime_input(
                    audio=types.Blob(
                        data=chunk,
                        mime_type="audio/pcm;rate=16000",
                    )
                )

        async def receive_audio():
            with sd.RawOutputStream(
                samplerate=OUTPUT_RATE,
                channels=1,
                dtype="int16",
            ) as output_stream:

                while True:
                    # receive() handles one model turn.
                    # Loop again for the next conversational turn.
                    async for response in session.receive():

                        content = response.server_content

                        if not content:
                            continue

                        # Final transcript of your speech
                        if content.input_transcription:
                            text = content.input_transcription.text
                            if text:
                                print(f"\nYou: {text}")

                        # Transcript of Gemini's spoken response
                        if content.output_transcription:
                            text = content.output_transcription.text
                            if text:
                                print(text, end="", flush=True)

                        # Gemini native audio
                        if content.model_turn:
                            for part in content.model_turn.parts:
                                if (
                                    part.inline_data
                                    and part.inline_data.data
                                ):
                                    output_stream.write(
                                        part.inline_data.data
                                    )

                        # Gemini detected that you interrupted it
                        if content.interrupted:
                            print("\n[Gemini interrupted]")

        with sd.RawInputStream(
            samplerate=INPUT_RATE,
            blocksize=BLOCK_SIZE,
            channels=1,
            dtype="int16",
            callback=mic_callback,
        ):
            await asyncio.gather(
                send_audio(),
                receive_audio(),
            )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n\n👋 Session ended")
