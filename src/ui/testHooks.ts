import { compile, defaultAdjustment, parseCube } from "../core/adjustments";
import { adjustPixels } from "../core/composite";
import { HIDE_ALL, REVEAL_ALL, createGroup, createLayer, fillPixels } from "../core/document";
import { rect } from "../core/geometry";
import { NO_PIXELS, pixelsFromImage } from "../core/pixels";

/** Document building blocks for e2e tests that compare the GPU with the CPU reference on scenes built in the page. */
export const TEST_CORE = { compile, defaultAdjustment, parseCube, adjustPixels, HIDE_ALL, REVEAL_ALL, createGroup, createLayer, fillPixels, rect, NO_PIXELS, pixelsFromImage };
