function stringOption(name, description, { required = true, autocomplete = false } = {}) {
  return {
    type: 3,
    name,
    description,
    required,
    autocomplete,
  };
}

export function buildDiscordCommandManifest() {
  return [
    {
      name: "projects",
      description: "사용 가능한 프로젝트 목록을 조회합니다.",
      type: 1,
      options: [],
    },
    {
      name: "create-project",
      description: "새 프로젝트를 shared memory에 등록하고 현재 채널에 고정합니다.",
      type: 1,
      options: [
        stringOption("name", "표시할 프로젝트 이름"),
        stringOption("key", "프로젝트 키(선택, 비우면 자동 생성)", { required: false }),
        stringOption("goal", "초기 목표(선택)", { required: false }),
      ],
    },
    {
      name: "attach-thread",
      description: "기존 Codex thread를 현재 채널 프로젝트로 연결합니다.",
      type: 1,
      options: [stringOption("thread_id", "연결할 Codex thread id", { autocomplete: true })],
    },
    {
      name: "background-on",
      description: "현재 프로젝트를 background scheduler 대상로 전환합니다.",
      type: 1,
      options: [stringOption("project", "대상 프로젝트 키", { required: false, autocomplete: true })],
    },
    {
      name: "foreground-on",
      description: "현재 프로젝트를 foreground 작업 모드로 전환합니다.",
      type: 1,
      options: [stringOption("project", "대상 프로젝트 키", { required: false, autocomplete: true })],
    },
    {
      name: "status",
      description: "프로젝트 현재 상태를 조회합니다.",
      type: 1,
      options: [stringOption("project", "대상 프로젝트 키", { required: false, autocomplete: true })],
    },
    {
      name: "use-project",
      description: "현재 채널의 기본 프로젝트를 지정합니다.",
      type: 1,
      options: [stringOption("project", "현재 채널에 바인딩할 프로젝트", { autocomplete: true })],
    },
    {
      name: "intent",
      description: "프로젝트 메인에게 새 작업 지시를 남깁니다.",
      type: 1,
      options: [
        stringOption("request", "전달할 작업 지시"),
        stringOption("project", "대상 프로젝트 키", { required: false, autocomplete: true }),
      ],
    },
    {
      name: "reply",
      description: "질문 turn에 대한 follow-up 답변을 남깁니다.",
      type: 1,
      options: [
        stringOption("request", "전달할 답변"),
        stringOption("source_ref", "질문 또는 대기 source_ref"),
        stringOption("project", "대상 프로젝트 키", { required: false, autocomplete: true }),
      ],
    },
    {
      name: "approve-candidate",
      description: "foreground human gate 후보를 기록합니다.",
      type: 1,
      options: [
        stringOption("source_ref", "현재 active approval source_ref"),
        stringOption("project", "대상 프로젝트 키", { required: false, autocomplete: true }),
      ],
    },
  ];
}
