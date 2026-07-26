/**
 * 为未自带 TypeScript 声明的离线 OpenCC 依赖收窄本项目所使用的接口；
 * 仅允许香港繁体到简体中文的转换配置，避免调用方误把商品标题交给不受审计的语言服务或其它地区词典。
 */
declare module "opencc-js" {
  /** 离线词典转换器的最小公开接口，输入和输出均为仍由调用方负责验证的标题文本。 */
  const OpenCC: {
    /** 创建固定地区方向的纯内存转换函数，不建立网络连接也不持久化商品标题。 */
    Converter(options: { from: "hk"; to: "cn" }): (value: string) => string;
  };

  export default OpenCC;
}
