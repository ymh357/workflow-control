Echo the prior turn's `subject` and `note` back as a single confirmation paragraph (under 50 words) and write it to the `message` output port.

If `subject` is missing or equals "unknown", echo that state explicitly rather than fabricating content. Do not call any tool other than `write_port`.
