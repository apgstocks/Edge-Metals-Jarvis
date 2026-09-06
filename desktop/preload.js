// Deliberately empty. The window loads the real dashboard, which needs
// nothing from Node — and every API exposed here would be one the remote page
// could call. The file exists because specifying a preload is what keeps
// contextIsolation meaningful; adding to it should be a decision, not a
// convenience.
