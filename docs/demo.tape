# Source for demo.gif. Regenerate with `vhs docs/demo.tape` from the repository root,
# with the stack already up (`NO_OPEN=1 ./scripts/walkthrough.sh` in another terminal).
#
# This records a real call against the Anthropic API, so the figures differ run to run —
# what stays fixed is the escrow, because that is computed before anything runs.

Output docs/demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1440
Set Height 900
Set Padding 22
Set Theme "Builtin Tango Dark"
Set TypingSpeed 45ms

Hide
Type "clear"
Enter
Sleep 1s
Show

Type "pnpm demo summarize"
Sleep 600ms
Enter
Sleep 30s
