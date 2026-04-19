// Wrangler's `Text` rule turns *.mustache imports into a string literal at
// bundle time so the Worker can ship templates without a filesystem.
declare module "*.mustache" {
  const text: string;
  export default text;
}
