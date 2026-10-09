HOVER-TO-REVEAL  ·  SMUDGE EDITION
===================================
Open index.html in any browser. No build step, no dependencies.
To publish: upload the whole folder to GitHub Pages, Vercel, Netlify, or any static host.

Files
  index.html      page markup (includes the reveal SVG)
  css/style.css   styles
  js/app.js       interaction
  img/            day / night images (WebP + JPG fallback, same size so they align)

The page
  A full-bleed hero and nothing else. No controls, no buttons, nothing
  moving on its own — the effect only starts when the pointer moves
  across the page (or a finger drags on touch). It stops when the
  pointer leaves the window, or about a second after you lift your finger.

  Desktop   move the pointer | mouse wheel resizes the blob
  Mobile    touch and drag
  Keyboard  click the page, then arrow keys move the blob around

What the reveal does
  Moving the pointer (or dragging on touch) paints a stroke that shows the
  night image through the day image. The stroke has smooth, soft-edged brush,
  a big round head plus a smooth ribbon that follows the
  exact path you drew, curves included.

  The stroke lingers, then dries out. It holds at full width briefly, then
  erodes from the tail end toward the head, thinning to a wisp and vanishing.
  Every new hover or drag paints its own stroke, so a fading one is never
  stitched to the next.

How it stays smooth
  The night image is drawn on a canvas through an offscreen mask. Only the
  dirty rectangle around the stroke is repainted each frame. The frame loop
  stops when nothing is visible. prefers-reduced-motion removes the wobble
  and the slow fade; the effect still works.

Tuning (top of js/app.js)
  HOLD     ms a fresh stroke stays at full width
  DECAY    ms it takes to erode away
  BODY_K   stroke width relative to the head
  SPACING  px between stroke points (smaller = smoother edge)

To swap images, replace img/day.* and img/night.* with new images of the
same size. The window aligns its copy with the CSS object-fit geometry
(object-position: 50% 40%), so as long as both files are the same
dimensions the layers stay registered.
