import asyncio
import os
import wave

from google import genai


MODEL = "gemini-3.1-flash-live-preview"


async def main():
    if not os.getenv("GEMINI_API_KEY"):
        raise RuntimeError("GEMINI_API_KEY is not set")

    client = genai.Client()

    config = {
        "response_modalities": ["AUDIO"],
        "output_audio_transcription": {},
    }

    print("Connecting to Gemini Live...")

    try:
        async with client.aio.live.connect(
            model=MODEL,
            config=config,
        ) as session:

            print("Connected successfully.")

            await session.send_client_content(
                turns={
                    "role": "user",
                    "parts": [
                        {
                            "text": (
                                "Say a short greeting and confirm that "
                                "the Gemini Live API connection is working."
                            )
                        }
                    ],
                },
                turn_complete=True,
            )

            audio_chunks = []

            async for response in session.receive():
                content = response.server_content

                if not content:
                    continue

                # Print Gemini's spoken-response transcript
                if content.output_transcription:
                    text = content.output_transcription.text
                    if text:
                        print(text, end="", flush=True)

                # Collect native Gemini audio
                if content.model_turn:
                    for part in content.model_turn.parts:
                        if part.inline_data and part.inline_data.data:
                            audio_chunks.append(part.inline_data.data)

                if content.turn_complete:
                    break

            print("\n\nResponse finished.")

            # Save the native Gemini voice so we can listen to it
            if audio_chunks:
                with wave.open("gemini_response.wav", "wb") as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)
                    wf.setframerate(24000)
                    wf.writeframes(b"".join(audio_chunks))

                print("Saved audio to: gemini_response.wav")

    finally:
        await client.aio.aclose()


if __name__ == "__main__":
    asyncio.run(main())
