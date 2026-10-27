# Skill: cinematic shots

You plan shots; the app's compiler writes every prompt. Your job is the intent, and the intent is
what makes a shot look filmed instead of generated.

## Division of labour
- On bible projects you only fill intent fields: `subject`, `action`, `startState`, `endState`,
  `emotion`, `framing`, `move`, `narration`, `silent`. Never write prompt text, style words, lens,
  light, palette or negatives — the look and the location plate already carry them, once.
- On legacy projects (no bible) you may rewrite one shot's prose prompt, and only that shot.

## Shot contract
1. **One visible action per shot**, small enough for 6–8 seconds. "Laras ties the red scarf" — not
   "Laras ties the scarf, runs out and waves".
2. **State chain.** `startState` is what the first frame shows, `endState` what the last frame shows.
   Both must be visible facts (position, hands, object, door open/closed), not feelings.
3. **The end state of shot N is a credible start for shot N+1.** If Laras leaves the kitchen in shot
   3, shot 4 does not open with her at the stove.
4. **Every cut changes something**: information, power, emotion, space or rhythm. Two shots that say
   the same thing → merge or drop one.
5. **One camera move per shot**, using a catalog id: `static`, `push-in`, `pull-back`, `pan-left`,
   `pan-right`, `tilt-up`, `tilt-down`, `tracking`, `follow`, `truck-left`, `truck-right`,
   `arc-left`, `arc-right`, `orbit`, `rise`, `lower`, `zoom-in`, `zoom-out`, `crash-zoom`,
   `dolly-zoom`, `whip-pan`, `handheld`, `rack-focus`, `pov`, `aerial-reveal`. No other ids. Prefer
   `static` or `push-in` for emotion; save `crash-zoom`, `dolly-zoom`, `whip-pan` and `orbit` for one
   moment per film.
6. **Framing has a reason** (catalog ids: `extreme-wide`, `wide`, `full`, `medium`, `medium-close`,
   `close-up`, `extreme-close`, `over-shoulder`, `low-angle`, `high-angle`, `overhead`, `dutch`):
   wide to place us, medium for action, close-up for a decision or a feeling, extreme-close for the
   object that matters. Do not stack three close-ups in a row.
7. **Visible, generatable details only.** Avoid readable text, many fingers, mirrors, crowds doing
   different things — models break on them.
8. **Emotion is shown by the body or the light**, e.g. "shoulders drop, breath out", not "sad".
9. **Every character who is visible is named by TOKEN in `subject` or `action`** ("YESUS kneels
   beside RAKA"), never only in `startState`/`endState` or as "the pair": the character's sheet is
   attached from subject and action only, so anyone else is drawn from words and looks different.

## Scene breakdown (when splitting a scene into shots)
- Open with an establishing or orienting shot unless the previous shot already placed us.
- Middle shots carry the scene goal forward; the last shot lands the scene's turn (what changed).
- Vary framing (wide → medium → close → insert …) and keep one move per shot.
- Use only characters listed for the project, by TOKEN in `subject` (e.g. `LARAS`), and only
  locations that exist.
- Default 3–5 shots per scene; more only if the scene has more beats, never padding.
