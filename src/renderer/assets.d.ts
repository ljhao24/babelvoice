// Asset module declarations for Vite. Importing one of these from a .ts/.tsx
// file gives you the asset's URL as a string at runtime; in dev Vite serves
// it directly, in production it's emitted with a hashed filename.

declare module '*.m4a' {
  const url: string;
  export default url;
}

declare module '*.mp3' {
  const url: string;
  export default url;
}

declare module '*.wav' {
  const url: string;
  export default url;
}

declare module '*.mp4' {
  const url: string;
  export default url;
}

declare module '*.svg' {
  const url: string;
  export default url;
}
