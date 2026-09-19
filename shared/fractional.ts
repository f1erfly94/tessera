/**
 * Fractional indexing: order keys you can always insert between.
 *
 * Between any two keys there is always another one, so moving a shape to the
 * front, the back or between two others rewrites that one shape's key and
 * nothing else — which is what lets two people reorder layers at the same time
 * without their changes trampling each other.
 *
 * A key is an integer part followed by an optional fraction, all in base 62:
 *
 * - the integer part's first character encodes its own length: "a" is a
 *   two-character integer ("a0" … "az"), "b" a three-character one, and upper
 *   case runs the same way downwards for negative integers;
 * - the fraction is only used to squeeze between two neighbouring integers.
 *
 * The integer part is what keeps keys short in the common case. Every new shape
 * goes on top, i.e. after the current last key; with fractions alone every few
 * such appends add a character (a test crossed 64 characters within a few
 * hundred), while incrementing an integer does not ("a0", "a1", … "az", "b00", …).
 *
 * Keys compare with plain `<` on strings: the digit alphabet is in ASCII order.
 */
export const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const ZERO = DIGITS[0]!;
const LAST = DIGITS[DIGITS.length - 1]!;
/** The smallest integer; reserved so there is always room below every key. */
const SMALLEST_INTEGER = `A${ZERO.repeat(26)}`;
const MAX_KEY_LENGTH = 64;

const integerLength = (head: string): number => {
    if (head >= "a" && head <= "z") return head.charCodeAt(0) - "a".charCodeAt(0) + 2;
    if (head >= "A" && head <= "Z") return "Z".charCodeAt(0) - head.charCodeAt(0) + 2;
    throw new Error(`Invalid order key head "${head}"`);
};

const integerPart = (key: string): string => {
    const length = integerLength(key[0] ?? "");
    if (length > key.length) throw new Error(`Invalid order key "${key}"`);
    return key.slice(0, length);
};

export const isValidKey = (key: string): boolean => {
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
    if (![...key].every((char) => DIGITS.includes(char))) return false;
    if (key === SMALLEST_INTEGER) return false;
    try {
        const fraction = key.slice(integerPart(key).length);
        return !fraction.endsWith(ZERO);
    } catch {
        return false;
    }
};

const assertValid = (key: string) => {
    if (!isValidKey(key)) throw new Error(`Invalid order key "${key}"`);
};

/** The midpoint of two fractions, where "" is 0 and `null` for `b` means 1. */
const midpoint = (a: string, b: string | null): string => {
    if (b !== null) {
        // A shared prefix stays as it is; the midpoint lives after it.
        let shared = 0;
        while ((a[shared] ?? ZERO) === b[shared]) shared++;
        if (shared > 0) return b.slice(0, shared) + midpoint(a.slice(shared), b.slice(shared));
    }

    const low = a ? DIGITS.indexOf(a[0]!) : 0;
    const high = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;

    if (high - low > 1) return DIGITS[Math.round((low + high) / 2)]!;

    // The first digits are neighbours, so the answer starts with a's digit and
    // continues somewhere between the rest of a and "one".
    if (b !== null && b.length > 1) return b.slice(0, 1);
    return DIGITS[low]! + midpoint(a.slice(1), null);
};

/** The next integer up, or null past the largest one. */
const increment = (integer: string): string | null => {
    const [head, ...digits] = [...integer];
    let carry = true;
    for (let index = digits.length - 1; carry && index >= 0; index--) {
        const next = DIGITS.indexOf(digits[index]!) + 1;
        if (next === DIGITS.length) {
            digits[index] = ZERO;
        } else {
            digits[index] = DIGITS[next]!;
            carry = false;
        }
    }
    if (!carry) return head + digits.join("");
    if (head === "Z") return `a${ZERO}`;
    if (head === "z") return null;
    const nextHead = String.fromCharCode(head!.charCodeAt(0) + 1);
    if (nextHead > "a") digits.push(ZERO);
    else digits.pop();
    return nextHead + digits.join("");
};

/** The next integer down, or null below the smallest one. */
const decrement = (integer: string): string | null => {
    const [head, ...digits] = [...integer];
    let borrow = true;
    for (let index = digits.length - 1; borrow && index >= 0; index--) {
        const next = DIGITS.indexOf(digits[index]!) - 1;
        if (next === -1) {
            digits[index] = LAST;
        } else {
            digits[index] = DIGITS[next]!;
            borrow = false;
        }
    }
    if (!borrow) return head + digits.join("");
    if (head === "a") return `Z${LAST}`;
    if (head === "A") return null;
    const nextHead = String.fromCharCode(head!.charCodeAt(0) - 1);
    if (nextHead < "Z") digits.push(LAST);
    else digits.pop();
    return nextHead + digits.join("");
};

/**
 * A key strictly between `before` and `after`. `null` means "no neighbour on this
 * side", so `keyBetween(null, null)` is the first key of an empty list.
 */
export const keyBetween = (before: string | null, after: string | null): string => {
    if (before !== null) assertValid(before);
    if (after !== null) assertValid(after);
    if (before !== null && after !== null && before >= after) {
        throw new Error(`Keys out of order: "${before}" >= "${after}"`);
    }

    if (before === null) {
        if (after === null) return `a${ZERO}`;
        const integer = integerPart(after);
        const fraction = after.slice(integer.length);
        if (integer === SMALLEST_INTEGER) return integer + midpoint("", fraction);
        if (integer < after) return integer;
        const lower = decrement(integer);
        if (lower === null) throw new Error("No key below the smallest one");
        return lower;
    }

    const integer = integerPart(before);
    const fraction = before.slice(integer.length);

    if (after === null) {
        const higher = increment(integer);
        return higher === null ? integer + midpoint(fraction, null) : higher;
    }

    const afterInteger = integerPart(after);
    if (integer === afterInteger) return integer + midpoint(fraction, after.slice(afterInteger.length));

    const higher = increment(integer);
    if (higher === null) throw new Error("No key above the largest one");
    return higher < after ? higher : integer + midpoint(fraction, null);
};

/** `count` ascending keys between two neighbours, spread out rather than stacked at one end. */
export const keysBetween = (before: string | null, after: string | null, count: number): string[] => {
    if (count <= 0) return [];
    if (count === 1) return [keyBetween(before, after)];
    const middle = keyBetween(before, after);
    const half = Math.floor(count / 2);
    return [...keysBetween(before, middle, half), middle, ...keysBetween(middle, after, count - half - 1)];
};
