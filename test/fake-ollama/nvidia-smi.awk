# The JSON reader only retains the fields used by nvidia-smi.ts. It still walks
# nested values and quoted strings, so model metadata cannot look like a field.
function whitespace() { while (substr(json, pos, 1) ~ /^[ \t\r\n]$/) pos++ }
function string(    result, c, escape, hex, code, i, digit) {
    result = ""
    pos++
    while (pos <= length(json)) {
        c = substr(json, pos++, 1)
        if (c == "\"") { value = result; kind = "string"; return }
        if (c ~ /^[\001-\037]$/) { bad = 1; return }
        if (c == "\\") {
            escape = substr(json, pos++, 1)
            if (escape == "u") {
                hex = substr(json, pos, 4)
                if (length(hex) != 4 || hex ~ /[^0-9a-fA-F]/) { bad = 1; return }
                pos += 4
                code = 0
                for (i = 1; i <= 4; i++) {
                    digit = index("0123456789abcdef", tolower(substr(hex, i, 1))) - 1
                    code = code * 16 + digit
                }
                # Only ASCII can name a retained field; other escapes stay opaque.
                c = code > 0 && code < 128 ? sprintf("%c", code) : "\\u" hex
            } else if (escape ~ /^["\\\/bfnrt]$/) c = "\\" escape
            else { bad = 1; return }
        }
        result = result c
    }
    bad = 1
}
# Contexts: 1 root object, 2 loaded array, 3 one loaded entry, 0 ignored data.
function parse(context,    c, key, nextContext, size, sum) {
    whitespace()
    c = substr(json, pos, 1)
    if (c == "\"") { string(); return }
    if (c == "{" || c == "[") {
        pos++
        whitespace()
        size = sum = 0
        if (substr(json, pos, 1) != (c == "{" ? "}" : "]")) {
            while (!bad) {
                nextContext = 0
                if (c == "{") {
                    if (substr(json, pos, 1) != "\"") { bad = 1; return }
                    string(); key = value
                    whitespace()
                    if (substr(json, pos++, 1) != ":") { bad = 1; return }
                    if (context == 1 && key == "loaded") nextContext = 2
                } else if (context == 2) nextContext = 3
                parse(nextContext)
                if (bad) return
                if (c == "{" && context == 1) {
                    if (key == "loaded") runner = kind == "array" ? value : 0
                    if (key == "otherMib") other = kind == "number" ? value : 0
                    if (key == "totalMib") total = kind == "number" ? value : 16303
                    if (key == "absent") absent = kind == "true"
                }
                if (c == "{" && context == 3 && key == "sizeBytes") size = kind == "number" ? value : 0
                if (c == "[" && context == 2 && kind == "object") sum += value
                whitespace()
                if (substr(json, pos, 1) != ",") break
                pos++
                whitespace()
            }
        }
        if (substr(json, pos++, 1) != (c == "{" ? "}" : "]")) { bad = 1; return }
        kind = c == "{" ? "object" : "array"
        # Math.round rounds negative half values toward positive infinity too.
        size = size / 1048576 + 0.5
        value = c == "[" ? sum : int(size) - (size < int(size) ? 1 : 0)
        return
    }
    if (match(substr(json, pos), /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/)) {
        value = substr(json, pos, RLENGTH) + 0; pos += RLENGTH; kind = "number"; return
    }
    if (match(substr(json, pos), /^(true|false|null)/)) {
        kind = substr(json, pos, RLENGTH); pos += RLENGTH; value = 0; return
    }
    bad = 1
}
BEGIN {
    total = 16303
    file = ENVIRON["GATES_LOCAL_FAKE_GPU_STATE"]
    if (file != "") {
        while ((read = (getline line < file)) > 0) json = json line "\n"
        close(file)
        pos = 1
        parse(1)
        whitespace()
        if (bad || read < 0 || pos <= length(json)) { runner = other = absent = 0; total = 16303 }
    }
    if (absent) { print "No devices were found"; exit 6 }
    used = 4182 + (other > 0 ? other : 0) + (runner > 0 ? runner : 0)
    free = total > used ? total - used : 0
    name = "NVIDIA GeForce RTX 5070 Ti"
    query = ENVIRON["GL_FAKE_SMI_QUERY"]
    if (query == "--query-gpu=memory.total,memory.used,memory.free") printf "%.15g, %.15g, %.15g\n", total, used, free
    else if (query == "--query-gpu=name,memory.total,memory.used,memory.free") printf "%s, %.15g, %.15g, %.15g\n", name, total, used, free
    else if (query == "--query-gpu=name") print name
    else if (query == "--query-compute-apps=pid,process_name,used_memory") {
        print "2101, /usr/local/bin/whisper-server, 2150"
        print "3388, /opt/media-vault/bin/media-vault-vision, 1822"
        if (other > 0) printf "3902, /usr/bin/blender, %.15g\n", other
        if (runner > 0) printf "4410, /usr/local/bin/ollama, %.15g\n", runner
    } else {
        print "fake nvidia-smi: unsupported arguments " ENVIRON["GL_FAKE_SMI_ARGS"] > "/dev/stderr"
        exit 2
    }
    exit
}
