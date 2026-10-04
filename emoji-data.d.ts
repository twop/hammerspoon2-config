// Ambient shape for unicode-emoji-json's data file, imported directly by
// emoji-picker.ts. Declared by hand (rather than relying on tsconfig's
// resolveJsonModule to infer a literal type from the file) so tsc doesn't
// have to structurally type ~1900 object keys on every check.
declare module "unicode-emoji-json/data-by-emoji.json" {
	interface EmojiMeta {
		name: string;
		slug: string;
		group: string;
		emoji_version: string;
		unicode_version: string;
		skin_tone_support: boolean;
	}
	const data: Record<string, EmojiMeta>;
	export default data;
}
