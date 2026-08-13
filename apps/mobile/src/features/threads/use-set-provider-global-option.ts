import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ServerProviderGlobalOptionSetInput } from "@t3tools/contracts";
import { useCallback } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

function providerGlobalOptionError(failure: unknown): Error {
  if (failure instanceof Error) {
    return failure;
  }
  if (
    typeof failure === "object" &&
    failure !== null &&
    "message" in failure &&
    typeof failure.message === "string"
  ) {
    return new Error(failure.message);
  }
  return new Error("Could not update the provider setting.");
}

/**
 * Applies one provider-global (native) setting change for the settings sheet.
 * Rejects with a displayable error so the sheet can alert, and treats a null
 * environment id as "nothing selected yet" rather than sending a request.
 */
export function useSetProviderGlobalOption(environmentId: EnvironmentId | null) {
  const setProviderGlobalOption = useAtomCommand(serverEnvironment.setProviderGlobalOption, {
    reportFailure: false,
  });

  return useCallback(
    async (input: ServerProviderGlobalOptionSetInput) => {
      if (!environmentId) {
        throw new Error("No environment is selected.");
      }
      const result = await setProviderGlobalOption({ environmentId, input });
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) {
        return;
      }
      throw providerGlobalOptionError(squashAtomCommandFailure(result));
    },
    [environmentId, setProviderGlobalOption],
  );
}
