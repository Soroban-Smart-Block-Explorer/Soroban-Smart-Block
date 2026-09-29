// Issue #923: i128/u128 amounts are serialized as strings; brand them so they can
// never be passed where a `number` is expected.
declare const i128Brand: unique symbol;
export type I128 = string & { readonly [i128Brand]: "I128" };

export function asI128(value: string): I128 {
  if (!/^-?\d+$/.test(value)) throw new TypeError(`Not an i128 string: ${value}`);
  return value as I128;
}
