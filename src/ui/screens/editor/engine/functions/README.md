# Engine Functions

This folder contains composition engine utilities extracted from the original monolithic file.

## Modules

1. common.ts

- Shared math and geometry helpers.

2. config.ts

- Default composition config.

3. layout.ts

- Video and webcam layout computation.

4. background.ts

- Background rendering for color and gradient styles.

5. cuts.ts

- Cut-region normalization and source/composition time mapping.

6. zoom.ts

- Zoom-state computation from keyframes or zoom regions.

7. video-layers.ts

- Video and webcam layer drawing utilities.

8. cursor.ts

- Cursor sampling and cursor effects rendering.

9. render.ts

- Final composition frame rendering orchestration.

## Backward Compatibility

Public exports are re-exported through [src/ui/screens/editor/engine/functions.ts](src/ui/screens/editor/engine/functions.ts).

## Guides

- [Adding a New Render Layer](./ADDING_LAYER.md)
