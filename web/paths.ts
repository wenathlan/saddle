/** Resolves public asset paths for root hosting and repository subpath hosting. */
const rawbaseurl = import.meta.env.BASE_URL || "/";
const baseurl = rawbaseurl === "/" ? "/" : `/${rawbaseurl.replace(/^\/+|\/+$/g, "")}/`;

/** Builds a public URL without depending on a trailing slash in Vite's base value. */
export function assetpath(relativepath: string) {
  return `${baseurl}${relativepath.replace(/^\/+/, "")}`;
}
