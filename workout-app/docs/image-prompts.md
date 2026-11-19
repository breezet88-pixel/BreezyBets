# Making exercise pictures

The admin page has a **✨ Create image prompt** button on every exercise. It builds a prompt from the exercise name, muscles, equipment and form cues, plus one shared "image style" paragraph (editable under *Image style used in every prompt*). Copy it into your image tool, download the result, then upload it on the same exercise card.

## Which image tool

No AI tool is perfect at exercise form, so pick for **consistency** and **instruction-following**, not just beauty. These are the three I would shortlist; rankings change quickly, so run the same 3 exercises through each before committing.

| Tool | Why | Watch out for |
|---|---|---|
| **Google Gemini image model ("Nano Banana")** | Strong at following long, specific prompts and at *editing an existing image*, which is how you keep the same athlete across 100 exercises. | Check hands and feet on every image. |
| **OpenAI image generation (ChatGPT / GPT Image)** | Good at clean illustration styles and at placing no text in the image. Easy to iterate in conversation ("same character, now doing a lunge"). | Same: check limbs and joint angles. |
| **Adobe Firefly** | Trained on licensed content and sold with commercial-use terms, the safest choice if you will sell the app. | Less precise with body positions than the other two. |

Midjourney makes the prettiest pictures, but it is weakest at keeping one character identical and at obeying anatomy instructions, so I would not start there.

**Check the licence/terms of whichever tool you choose for commercial use** before you publish.

## A workflow that keeps the set consistent

1. Generate **one** "hero" image: the athlete standing neutrally, in your chosen style. Keep it.
2. For each exercise, upload the hero image to the tool as a reference and paste the prompt from the admin page, adding: *"Use the attached image as the character and style reference."*
3. Generate 3 to 4 options and pick the one with correct form.
4. **Check every image like a coach would:** neutral spine, knees tracking over toes, correct grip, two arms, two legs, five fingers. A wrong-looking picture teaches wrong form, so reject it and regenerate.
5. Upload as PNG, JPG or WebP (under 5 MB). 1200 px wide is plenty.

## The prompt template

```
Instructional fitness illustration showing ONE athlete performing "<EXERCISE>" using <EQUIPMENT>.
Two panels side by side, same athlete and same camera angle in both: LEFT = starting position,
RIGHT = finishing position (peak of the movement). Use a side view unless the movement is
clearer from the front. Full body in frame, 4:3 landscape.
Softly highlight the working muscles: <MUSCLES>.
Correct form to show: <FORM CUES>
Anatomically correct proportions, natural joint angles, neutral spine, exactly two arms and two
legs, correct number of fingers. No text, no labels, no arrows, no watermark, no extra equipment
or people.
Style: <YOUR STYLE PARAGRAPH>
```

Default style paragraph:

```
Clean flat vector illustration in a consistent style: one gender-neutral athlete with a plain
face, dark grey fitted sportswear, solid white background, soft ground shadow, teal (#0f766e)
used only to highlight the working muscles. The same character, same line weight and same
colours in every image of this series.
```

For moves that are hard to read from one angle (planks, bridges), change the camera line to a specific view, for example *"3/4 front view"*.

## Alternative: real photos or video

If you can film yourself, real photos beat AI pictures on accuracy. Upload them the same way (GIFs also work).
