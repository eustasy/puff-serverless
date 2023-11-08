import {puff_hashing_sha1_hibp} from './utilities_hashing.js'

export async function password_check(pw) {
	let result = true
	if (pw.length < 12) {
		result = false
	}

	const hasNumber = /\d/
	if (!hasNumber.test(pw)) {
		result = false
	}

	const hasSpecial = /[!-/:-@[-`{-~]/
	if (!hasSpecial.test(pw)) {
		result = false
	}

	return result
}

export async function password_requirements(pw) {
	let response_html = '<h3>Password Requirements</h3><ul>'

	if (pw.length >= 12) {
		response_html +=
			'<li style="color:#064e3b"><strong>Must</strong> be at least 12 characters long</li>'
	} else {
		response_html +=
			'<li style="color:#7f1d1d"><strong>Must</strong> be at least 12 characters long</li>'
	}

	const hasNumber = /\d/
	// TODO Test these assertions:
	// hasNumber.test("ABC33SDF");  // true
	// hasNumber.test("ABCSDF");  // false
	response_html += hasNumber.test(pw)
		? '<li style="color:#064e3b">Should contain a number</li>'
		: '<li style="color:#7f1d1d">Should contain a number</li>'

	const hasSpecial = /[^a-zA-Z\d]/
	if (hasSpecial.test(pw)) {
		response_html +=
			'<li style="color:#064e3b">Should contain a special character</li>'
	} else {
		response_html +=
			'<li style="color:#7f1d1d">Should contain a special character</li>'
	}

	const pw_sha1 = await puff_hashing_sha1_hibp(pw)
	// Response_html += '<li>' + pw_sha1.f5 + ' : ' + pw_sha1.l35 + '</li>'
	try {
		let compromised = 0
		await fetch('https://api.pwnedpasswords.com/range/' + pw_sha1.f5)
			.then((response) => response.text())
			.then((text) => {
				// Response_html += '<li>' + text + '</li>'
				const inputArray = text.split('\n')
				// TODO Minor perf improvement: This for loop always runs the full length, but if we wrap it in a non-exported function we can `return` when we find a match.
				for (const element of inputArray) {
					const line_f35 = element.slice(0, 35)
					const line_ln = element.slice(36)
					// Response_html += '<li>' + i + ' : ' + line_f35 + ' : ' + line_ln + '</li>'
					if (line_f35 == pw_sha1.l35.toUpperCase()) {
						compromised = Number.parseInt(line_ln)
					}
				}
			})

		if (compromised > 0) {
			response_html +=
				'<li style="color:#7f1d1d">Has been compromised ' +
				Intl.NumberFormat().format(compromised) +
				' times</li>'
		} else {
			response_html +=
				'<li style="color:#064e3b">Should not be compromised</li>'
		}
	} catch (error) {
		response_html += '<li>' + error + '</li>'
	}

	response_html += '</ul>'
	return response_html
}
