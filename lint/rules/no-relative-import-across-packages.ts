import { eachImport, landsIn, packageOf, repoPath, type Rule } from "./rule.ts";

const rule: Rule = {
  meta: {
    type: "problem",
    docs: { description: "A relative import never lands in another app or package." },
  },
  create(context) {
    const home = packageOf(repoPath(context));
    if (home === undefined) return {};
    return eachImport((node, specifier) => {
      const target = landsIn(context, specifier);
      const other = target === undefined ? undefined : packageOf(target);
      if (other === undefined || other === home) return;
      const fix = other.startsWith("packages/")
        ? `Import \`@gates-local/${other.slice("packages/".length)}\` by name; if it does not export this yet, add the export there.`
        : "An app never reads another app's files: move what both need into a package under packages/ and import that by name.";
      context.report({ node, message: `\`${specifier}\` leaves ${home} for ${other}. ${fix}` });
    });
  },
};

export default rule;
