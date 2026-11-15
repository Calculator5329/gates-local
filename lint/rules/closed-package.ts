import { eachImport, landsIn, packageOf, repoPath, type Rule } from "./rule.ts";

type Options = { allow: string[] };

const rule: Rule = {
  meta: {
    type: "problem",
    docs: { description: "A closed package imports its own files and the listed libraries, nothing else." },
    schema: [{
      type: "object",
      properties: { allow: { type: "array", items: { type: "string" } } },
      required: ["allow"],
      additionalProperties: false,
    }],
  },
  create(context) {
    const home = packageOf(repoPath(context));
    if (home === undefined) return {};
    const { allow } = context.options[0] as Options;
    const allowed = (specifier: string) => allow.some(name => specifier === name || specifier.startsWith(`${name}/`));
    const list = allow.map(name => `\`${name}\``).join(", ");
    return eachImport((node, specifier) => {
      const target = landsIn(context, specifier);
      if (target === undefined ? allowed(specifier) : packageOf(target) === home) return;
      context.report({
        node,
        message: `\`${specifier}\` is outside ${home}, which imports only its own files and ${list}. `
          + "Pass the value in from the caller, or put the code that needs this import in the package that owns it.",
      });
    });
  },
};

export default rule;
