/** 'oak_stairs' -> 'Oak Stairs' */
export const displayName = (n: string): string => String(n || "").replace(/^minecraft:/, "").split("_").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ")
