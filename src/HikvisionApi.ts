import https from 'https';
import Axios, { AxiosResponse, AxiosRequestConfig } from 'axios';
import { AxiosDigestAuth } from '@lukesthl/ts-axios-digest-auth';
import xml2js, { Parser } from 'xml2js';
import highland from 'highland';
import { PlatformConfig } from 'homebridge';

export interface HikVisionNvrApiConfiguration extends PlatformConfig {
  host: string
  port: Number
  secure: boolean
  ignoreInsecureTls: boolean
  username: string
  password: string
  debugFfmpeg: boolean
}

export class HikvisionApi {
  private _http: AxiosDigestAuth
  private _parser?: Parser
  private _baseURL?: string

  constructor(config: HikVisionNvrApiConfiguration) {
    this._baseURL = `http${config.secure ? 's' : ''}://${config.host}:${config.port}`
    const _axios = Axios.create({
      httpsAgent: new https.Agent({
        rejectUnauthorized: !config.ignoreInsecureTls
      })
    });
    this._http = new AxiosDigestAuth({
      username: config.username,
      password: config.password,
      axios: _axios
    });
    this._parser = new Parser({ explicitArray: false })
  }

  /*
    "DeviceInfo": {
    "$": {
      "version": "2.0",
      "xmlns": "http://www.isapi.org/ver20/XMLSchema"
    },
    "deviceName": "Network Video Recorder",
    "deviceID": "48443030-3637-3534-3837-f84dfcf8ef1c",
    "model": "DS-7608NI-I2/8P",
    "serialNumber": "DS-7608NI-I2/8P0820190316CCRRD00675487WCVU",
    "macAddress": "f8:4d:fc:f8:ef:1c",
    "firmwareVersion": "V4.22.005",
    "firmwareReleasedDate": "build 191208",
    "encoderVersion": "V5.0",
    "encoderReleasedDate": "build 191208",
    "deviceType": "NVR",
    "telecontrolID": "255"
  }
  */
  public async getSystemInfo() {
    return this._getResponse('/ISAPI/System/deviceInfo');
  }

  async getCameras() {
    const channels = await this._getResponse('/ISAPI/ContentMgmt/InputProxy/channels');
    const channelStatus = await this._getResponse('/ISAPI/ContentMgmt/InputProxy/channels/status');

    for (let i = 0; i < channels.InputProxyChannelList.InputProxyChannel.length; i++) {
      const channel = channels.InputProxyChannelList.InputProxyChannel[i];
      try {
        channel.capabilities = await this._getResponse(`/ISAPI/ContentMgmt/StreamingProxy/channels/${channel.id}01/capabilities`);
      } catch {
        console.log(`Error getting cabailities for channel ${channel.id}`);
      }
    }

    return channels.InputProxyChannelList.InputProxyChannel.map((channel: { status: any; id: any; name: string }) => {
      channel.status = channelStatus.InputProxyChannelStatusList.InputProxyChannelStatus.find((cs: { id: any; }) => {
        return cs.id === channel.id;
      });
      return channel;
    }).filter((camera: { status: { online: string; }; }) => camera.status.online === 'true');
  }

  async startMonitoringEvents(callback: (value: any) => any) {

    const xmlParser = new xml2js.Parser({
      explicitArray: false,
    });


    /*
      EventNotificationAlert: {
        '$': { version: '2.0', xmlns: 'http://www.isapi.org/ver20/XMLSchema' },
        ipAddress: '10.0.1.186',
        portNo: '80',
        protocolType: 'HTTP',
        macAddress: 'f8:4d:fc:f8:ef:1c',
        dynChannelID: '1',
        channelID: '1',
        dateTime: '2020-02-19T18:44:4400:00',
        activePostCount: '1',
        eventType: 'fielddetection',
        eventState: 'active',
        eventDescription: 'fielddetection alarm',
        channelName: 'Front door',
        DetectionRegionList: { DetectionRegionEntry: [Object] }
      }
      */


    const url = `/ISAPI/Event/notification/alertStream`

    // TODO: what do we do if we lose our connection to the NVR? Don't we need to re-connect?
    this.get(url, {
      responseType: 'stream',
      headers: {}
    }).then(response => {
      highland(response!.data)
        .map((chunk: any) => chunk.toString('utf8'))
        .filter(text => text.match(/<\?xml/))
        .map(text => text.replace(/[\s\S]*<\?xml/gmi, '<?xml'))
        .map(xmlText => xmlParser.parseStringPromise(xmlText))
        .each(promise => promise.then(callback));
    });
  }

  async get(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse | undefined> {
    return this._http.get(this._baseURL + url, config);
  }

  private async _getResponse(path: string) {
    const response = await this._http.get<string>(this._baseURL + path);
    const responseJson = await this._parser?.parseStringPromise(response.data);
    return responseJson;
  }
}