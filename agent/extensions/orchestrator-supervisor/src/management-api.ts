import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSupervisorConfig, updateSupervisorConfig, resolveSupervisorConfigPath, SUPERVISOR_CONFIG_RANGES, validateSupervisorConfig } from './supervisor-config.ts';
import { loadSubagentConfig, updateSubagentConfig, resolveSubagentConfigPath, validateSubagentConfig } from './subagent-config.ts';
import { globalConfigPath, removeProjectOverride } from './config-scope.ts';
import { computeFlowIdentity, resolveSupervisorDir } from './config.ts';

/** Fixed bridge API used by Desktop. It never acknowledges mutations or changes credentials. */
export function manageSupervisor(cwd: string, request: any): unknown {
  if (!request || !['read', 'save', 'inherit'].includes(request.action) || !['global', 'project'].includes(request.scope)) throw new Error('Invalid supervisor request');
  const scope = request.scope as 'global' | 'project';
  const section = request.section;
  if (request.action !== 'read') {
    if (!['orchestrator', 'subagents'].includes(section)) throw new Error('Invalid configuration section');
    if (request.action === 'inherit') {
      if (scope !== 'project') throw new Error('Only projects can inherit global settings');
      if (section === 'orchestrator' && loadSupervisorConfig(cwd).config.enabled === false) {
        throw new Error('Inspect safety state and enable from the trusted terminal before removing this override');
      }
      removeProjectOverride(section === 'orchestrator' ? resolveSupervisorConfigPath(cwd) : resolveSubagentConfigPath(cwd));
    } else {
      const patch = request.config;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid configuration');
      // A settings editor must not clear a disabled/safety-halted session by saving enabled.
      if (section === 'orchestrator') {
        const targetPath = scope === 'global' ? globalConfigPath('supervisor.json') : resolveSupervisorConfigPath(cwd);
        const targetDisabled = existsSync(targetPath) && validateSupervisorConfig(JSON.parse(readFileSync(targetPath, 'utf8'))).enabled === false;
        if (patch.enabled === true && (targetDisabled || loadSupervisorConfig(cwd).config.enabled === false)) {
          throw new Error('Enable a disabled supervisor from the trusted terminal panel after inspecting safety state');
        }
        updateSupervisorConfig(cwd, validateSupervisorConfig(patch), undefined, scope);
      } else updateSubagentConfig(cwd, validateSubagentConfig(patch), undefined, scope);
    }
  }
  const globalRead = (section: 'supervisor.json' | 'subagents.json') => {
    const path = globalConfigPath(section);
    const validate = section === 'supervisor.json' ? validateSupervisorConfig : validateSubagentConfig;
    if (!existsSync(path)) return section === 'supervisor.json' ? validateSupervisorConfig({}) : validateSubagentConfig({});
    return validate(JSON.parse(readFileSync(path, 'utf8')));
  };
  const statePath = typeof request.sessionId === 'string' && request.sessionId
    ? join(resolveSupervisorDir(computeFlowIdentity(cwd, request.sessionId)), 'state.json') : undefined;
  let state: unknown;
  if (statePath && existsSync(statePath)) {
    const raw = JSON.parse(readFileSync(statePath, 'utf8'));
    state = { status: raw.status, safetyFault: raw.safetyFault, uncertainMutationsCount: raw.uncertainMutationsCount, owedProviderTurn: raw.owedProviderTurn };
  }
  return {
    scope, cwd,
    orchestrator: scope === 'global' ? globalRead('supervisor.json') : loadSupervisorConfig(cwd).config,
    subagents: scope === 'global' ? globalRead('subagents.json') : loadSubagentConfig(cwd).config,
    errors: { orchestrator: loadSupervisorConfig(cwd).error, subagents: loadSubagentConfig(cwd).error },
    projectOverrides: { orchestrator: existsSync(resolveSupervisorConfigPath(cwd)), subagents: existsSync(resolveSubagentConfigPath(cwd)) },
    paths: { orchestrator: scope === 'global' ? globalConfigPath('supervisor.json') : resolveSupervisorConfigPath(cwd), subagents: scope === 'global' ? globalConfigPath('subagents.json') : resolveSubagentConfigPath(cwd) },
    ranges: SUPERVISOR_CONFIG_RANGES, state,
  };
}
