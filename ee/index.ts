import type { PremiumSurface } from "@/lib/premium";
import { ai } from "./ai";
import { replies } from "./replies";
import { inmail } from "./inmail";

const premium: PremiumSurface = { ai, replies, inmail };

export default premium;
