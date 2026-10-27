import { PolicyPack } from "@pulumi/policy";
import { rules } from "./rules";

new PolicyPack("guestbook-guardrails", {
    policies: rules.map(rule => ({
        name: rule.name,
        description: rule.description,
        enforcementLevel: rule.level,
        validateResource: (args, reportViolation) => {
            if (!rule.types.includes(args.type)) return;
            for (const msg of rule.check(args.props)) reportViolation(`${args.name}: ${msg}`);
        },
    })),
});
