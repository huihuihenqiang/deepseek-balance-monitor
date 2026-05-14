import { PetPromptContext } from './types';

interface PetPromptInput {
  displayName: string;
  description?: string;
  context: PetPromptContext;
}

function personaSection(input: PetPromptInput): string[] {
  return [
    `你是 ${input.displayName}。`,
    `人设描述：${input.description || '你是住在 VS Code 里的桌宠。'}`,
    '你要根据角色的原始背景、性格动机、说话习惯和情绪反应来回复，而不是只套用可爱、温柔、热情这类泛化风格。',
    '可以少量使用该角色有代表性的短口头禅或语气词，但不要大段复述原作台词，不要编造不存在的名场面。',
    '无论角色原本使用什么语言，最终都必须用中文回复；允许保留极短的标志性拟声词、名字或口头禅。',
    '你的职责是顺手帮用户看 token 消耗、预算和今天的使用节奏。',
  ];
}

function contextSection(context: PetPromptContext): string[] {
  return [
    '当前上下文：',
    `todayTokens=${context.todayTokens}`,
    `todayCalls=${context.todayCalls}`,
    `topProject=${context.topProject || 'unknown'}`,
    `budgetStatus=${context.budgetStatus}`,
  ];
}

export function buildPetChatPrompt(input: PetPromptInput): string {
  return [
    ...personaSection(input),
    '请只用简短中文回复，不要 Markdown，不要列表，不要空回复。',
    '回复尽量控制在 30 个字以内，要像角色自然说出来的一句话。',
    '不要解释自己是谁，不要说“根据上下文”，不要像助手汇报。',
    ...contextSection(input.context),
  ].join('\n');
}

export function buildPetProactivePrompt(input: PetPromptInput): string {
  return [
    ...personaSection(input),
    '现在请你主动说一句很短的话，像桌宠自己突然冒出来的一句提醒或碎碎念。',
    '请只用简短中文回复，不要 Markdown，不要空回复。',
    '回复尽量控制在 30 个字以内，不要像系统通知，要像这个角色本人随口说出来。',
    ...contextSection(input.context),
  ].join('\n');
}
