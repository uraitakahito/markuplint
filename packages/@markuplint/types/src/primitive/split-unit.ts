/**
 *
 * @param value
 * @returns
 */
export function splitUnit(value: string) {
	value = value.trim().toLowerCase();
	const matched = value.match(/(^-?\.\d+|^-?\d+(?:\.\d+(?:e[+-]\d+)?)?)([a-z]+$)/i);
	if (!matched) {
		return {
			num: value,
			unit: '',
		};
	}
	const [, num, unit] = matched;
	return {
		num: num ?? value,
		unit: unit ?? '',
	};
}
