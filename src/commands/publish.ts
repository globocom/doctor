import * as path from 'path';
import * as fg from 'fast-glob';
import * as fs from 'fs';
import Listr = require('listr');
import parseMarkdown = require('frontmatter');
import showdown = require('showdown');
import kleur = require('kleur');
import { JSDOM } from 'jsdom';
import { FileHelpers } from '../helpers/FileHelpers';
import { execScript } from '../helpers/execScript';
import { Observable } from 'rxjs';
import { FolderHelpers } from '../helpers/FolderHelpers';
import { NavigationHelper } from '../helpers/NavigationHelper';
import { CommandArguments } from '../models/CommandArguments';
import { Authenticate } from './authenticate';
import { PublishOutput } from '../models/PublishOutput';
import { Logger } from '../helpers/logger';
import { FrontMatterHelper } from '../helpers/FrontMatterHelper';
import { MarkdownHelper } from '../helpers/MarkdownHelper';
import { ArgumentsHelper } from '../helpers/ArgumentsHelper';
import { Page } from '../models/Page';
import { HeaderHelper } from './../helpers/HeaderHelper';
import { ListData } from './../models/ListData';

export class Publish {

  /**
   * Publishes the markdown files to SharePoint
   * @param options 
   */
  public static async start(options: CommandArguments) {
    Logger.debug(`Running with the following options: ${JSON.stringify(options)}`);

    if (!fs.existsSync(options.startFolder)) {
      return Promise.reject(new Error(`The provided folder location doesn't exist.`));
    }

    if (!options.webUrl) {
      return Promise.reject(new Error(`In order to run the publish command, you need to specify the '--url' property.`));
    }

    const { startFolder, webUrl } = options;

    let ouput: PublishOutput = {
      pagesProcessed: 0,
      imagesProcessed: 0,
      navigation: options.menu ? { ...options.menu } : null
    };

    // Initializes the authentication
    await Authenticate.init(options);

    await new Listr([
      {
        title: `Clean up all the files`,
        task: async () => {
          await FileHelpers.cleanUp(options, 'sitepages');
          await FileHelpers.cleanUp(options, options.assetLibrary)
        },
        enabled: () => options.cleanStart && options.confirm
      },
      {
        title: `Fetch all markdown files`,
        task: async (ctx: any) => await this.fetchMDFiles(ctx, startFolder)
      },
      {
        title: `Process markdown files`,
        task: async (ctx: any) => await this.processMDFiles(ctx, options, ouput)
      },
      {
        title: `Updating navigation`,
        task: async () => await NavigationHelper.update(webUrl, ouput.navigation)
      }
    ]).run().catch(err => {
      throw err;
    });

    console.log('');
    console.info(kleur.bold().bgYellow().black(` Publishing stats `));
    console.info(kleur.white(` Pages: ${ouput.pagesProcessed}`));
    console.info(kleur.white(` Images: ${ouput.imagesProcessed}`));
  }

  /**
   * Fetched the Markdown files from the start folder
   * @param ctx 
   * @param startFolder 
   */
  private static async fetchMDFiles(ctx: any, startFolder: string) {
    const files = await fg((`${startFolder}/**/*.md`).replace(/\\/g, '/'));

    if (files && files.length > 0) {
      ctx.files = files;
    } else {
      return Promise.reject(new Error(`No markdown files found in the folder.`));
    }
  }

  /**
   * Process the retrieved Markdown files
   * @param ctx 
   */
  private static async processMDFiles(ctx: any, options: CommandArguments, output: PublishOutput): Promise<Observable<string>> {
    const { webUrl, webPartTitle } = options;
    const converter = new showdown.Converter();

    return new Observable(observer => {
      (async () => {
        try {
          const { files } = ctx;

          for (const file of files) {
            if (file.endsWith('.md')) {
              const filename = path.basename(file);
              observer.next(`Started processing: ${filename}`);

              let contents = fs.readFileSync(file, { encoding: "utf-8" });
              if (contents) {

                let markup = parseMarkdown(contents);
                const htmlMarkup = converter.makeHtml(contents);
                const htmlElm = new JSDOM(htmlMarkup);
                const imgElms = [...htmlElm.window.document.querySelectorAll('img') as any] as HTMLImageElement[];
                const anchorElms = [...htmlElm.window.document.querySelectorAll('a') as any] as HTMLAnchorElement[];

                // Check if the required data for the article is present
                if (markup && markup.data) {
                  if (!markup.data.title) {
                    return Promise.reject(new Error(`The ${filename} has no 'title' defined`));
                  }
                }

                let { title, description, draft, comments, layout, header } = markup.data;
                let slug = FrontMatterHelper.getSlug(markup.data, options.startFolder, file);

                // Image processing
                if (imgElms && imgElms.length > 0) {
                  observer.next(`Uploading images referenced in ${filename}`);

                  markup = await this.processImages(imgElms, file, contents, options, output);
                }

                // Anchor processing
                if (anchorElms && anchorElms.length > 0) {
                  observer.next(`Processing links in ${filename}`);

                  Logger.debug(`Number of links in ${filename}: ${anchorElms.length}`)

                  try {
                    markup.content = this.processLinks(anchorElms, file, markup.content, options);
                  } catch (e) {
                    throw e.message;
                  }
                }

                // Checks if output needs to be generated
                if (options.outputFolder) {
                  const { outputFolder, startFolder } = options;
                  const processedFilePath = file.replace(startFolder, path.join(process.cwd(), outputFolder));
                  const dirPath = path.dirname(processedFilePath);
                  fs.mkdirSync(dirPath, { recursive: true });
                  fs.writeFileSync(processedFilePath, markup.content, { encoding: "utf-8" });
                }

                if (markup && markup.content) {
                  observer.next(`Creating or updating the page in SharePoint for ${filename}`);

                  // Check if the page already exists
                  await this.createPageIfNotExists(webUrl, slug, title, layout, comments, description);

                  // Check if the header of the page needs to be changed
                  await HeaderHelper.set(file, webUrl, slug, header, options);
      
                  // Retrieving all the controls from the page, so that we can start replacing the 
                  const controlData: string = await this.getPageControls(webUrl, slug);
                  
                  if (controlData) {
                    const webparts = JSON.parse(controlData);
                    const markdownWp = webparts.find((c: any) => c.title === webPartTitle);   
                    await this.insertOrCreateControl(webPartTitle, markup.content, slug, webUrl, markdownWp ? markdownWp.id : null);
                  }
                  
                  // Check if page needs to be published
                  if (typeof draft === "undefined" || !draft) {
                    observer.next(`Publishing ${filename}`);
                    await this.publishPageIfNeeded(webUrl, slug);
                  }

                  // Set the page its description
                  if (description) {
                    observer.next(`Setting page description for ${filename}`);
                    await this.setPageDescription(webUrl, slug, description);
                  }

                  ++output.pagesProcessed;
                }

                // Check if the file contains a menu element to add too
                if (output.navigation && markup && markup.data && markup.data.menu) {
                  Logger.debug(`Adding item to the navigation: ${slug} - ${title} - ${JSON.stringify(markup.data.menu)} `);

                  output.navigation = NavigationHelper.hierarchy(webUrl, output.navigation, markup.data.menu, slug, title);
                }
              }
            }
          }
        } catch (e) {
          observer.error(e);
          throw e.message;
        }
        observer.complete();
      })();
    });
  }

  /**
   * Process images referenced in the file
   * @param imgElms 
   * @param filePath 
   * @param contents 
   * @param options 
   * @param output 
   */
  private static async processImages(imgElms: HTMLImageElement[], filePath: string, contents: string, options: CommandArguments, output: PublishOutput) {
    const { startFolder, assetLibrary, webUrl, overwriteImages } = options;

    for (const img of imgElms.filter(i => !i.src.startsWith(`http`))) {
      const imgDirectory = path.join(path.dirname(filePath), path.dirname(img.src));
      const imgPath = path.join(path.dirname(filePath), img.src);

      const uniStartPath = startFolder.replace(/\\/g, '/');
      const folders = imgDirectory.replace(/\\/g, '/').replace(uniStartPath, '').split('/');
      let crntFolder = assetLibrary;

      // Start folder creation process
      crntFolder = await FolderHelpers.create(crntFolder, folders, webUrl);

      try {
        await FileHelpers.create(crntFolder, imgPath, webUrl, overwriteImages);

        contents = contents.replace(new RegExp(img.src, 'g'), `${webUrl}/${crntFolder}/${path.basename(img.src)}`);
        const markup = parseMarkdown(contents);
        ++output.imagesProcessed;

        return markup;
      } catch (e) {
        return Promise.reject(new Error(`Something failed while uploading the image asset. ${e.message}`));
      }
    }
  }

  /**
   * Process the links referenced in the markdown files
   * @param linkElms 
   * @param filePath 
   * @param content 
   * @param options 
   */
  private static processLinks(linkElms: HTMLAnchorElement[], filePath: string, content: string, options: CommandArguments) {
    const { webUrl, startFolder } = options;

    for (const link of linkElms.filter(i => !i.href.startsWith(`http`))) {

      const fileLink = link.href;
      let mdFile = "";

      Logger.debug(`Processing link: ${fileLink} for ${filePath}`);

      if (fileLink.endsWith(`.md`)) {
        mdFile = link.href;
      } else if (fileLink === ".") {
        mdFile = path.basename(filePath);
      } else {
        mdFile = `${link.href}.md`;
      }

      const mdFilePath = path.join(path.dirname(filePath), mdFile);

      Logger.debug(`File path for link: ${mdFilePath}`);

      if (fs.existsSync(mdFilePath)) {
        // Get the contents of the file
        const mdContents = fs.readFileSync(mdFilePath, { encoding: 'utf-8' });
        if (!mdContents) {
          return;
        } 

        // Get the slug
        const mdData = parseMarkdown(mdContents);
        if (!mdData || !mdData.data) {
          return;
        }

        const slug = FrontMatterHelper.getSlug(mdData.data, startFolder, mdFilePath);
        const spUrl = `${webUrl}${webUrl.endsWith('/') ? '' : '/'}sitepages/${slug}`;
        Logger.debug(`Referenced file slug: ${spUrl}`);

        // Update the link in the markdown
        content = content.replace(`(${fileLink})`, `(${spUrl})`);
      } else {
        Logger.debug(`Referenced file not found`);
      }
    }

    return content;
  }

  /**
   * Check if the page exists, and if it doesn't it will be created
   * @param webUrl 
   * @param slug 
   * @param title 
   */
  private static async createPageIfNotExists(webUrl: string, slug: string, title: string, layout: string = "Article", comments: boolean = false, description: string = ""): Promise<void> {
    try {
      let pageData = await execScript(`localm365`, ArgumentsHelper.parse(`spo page get --webUrl "${webUrl}" --name "${slug}" --output json`));
      if (pageData && typeof pageData === "string") {
        pageData = JSON.parse(pageData);

        Logger.debug(pageData);
      }

      if (pageData && (pageData as Page).layoutType !== layout) {
        await execScript(`localm365`, ArgumentsHelper.parse(`spo page set --webUrl "${webUrl}" --name "${slug}" --layoutType "${layout}" --description "${description}"`));
      }

      if (pageData && (pageData as Page).commentsDisabled !== !comments) {
        await execScript(`localm365`, ArgumentsHelper.parse(`spo page set --webUrl "${webUrl}" --name "${slug}" --commentsEnabled ${comments ? "true" : "false" }`));
      }
    } catch (e) {
      // Check if folders for the file need to be created
      if (slug.split('/').length > 1) {
        const folders = slug.split('/');
        await FolderHelpers.create('sitepages', folders.slice(0, folders.length - 1), webUrl);
      }
      // File doesn't exist
      await execScript(`localm365`, ArgumentsHelper.parse(`spo page add --webUrl "${webUrl}" --name "${slug}" --title "${title}" --layoutType "${layout}" ${comments ? "--commentsEnabled" : ""} --description "${description}"`));
    }
  }

  /**
   * Retrieve all the page controls
   * @param webUrl 
   * @param slug 
   */
  private static async getPageControls(webUrl: string, slug: string): Promise<string> {
    const output = await execScript<string>(`localm365`, ArgumentsHelper.parse(`spo page control list --webUrl "${webUrl}" --name "${slug}" -o json`));
    return output;
  }

  /**
   * Inserts or create the control
   * @param webPartTitle 
   * @param markdown 
   */
  private static async insertOrCreateControl(webPartTitle: string, markdown: string, slug: string, webUrl: string, wpId: string = null) {
    const wpData = MarkdownHelper.getJsonData(webPartTitle, markdown);
    
    if (wpId) {
      // Web part needs to be updated
      await execScript(`localm365`, [...ArgumentsHelper.parse(`spo page control set --webUrl "${webUrl}" --name "${slug}" --id "${wpId}" --webPartData`), wpData]);
    } else {
      // Add new markdown web part
      await execScript(`localm365`, [...ArgumentsHelper.parse(`spo page clientsidewebpart add --webUrl "${webUrl}" --pageName "${slug}" --webPartId 1ef5ed11-ce7b-44be-bc5e-4abd55101d16 --webPartData`), wpData]);
    }
  }

  /**
   * Set the page its description
   * @param webUrl 
   * @param slug 
   * @param description 
   */
  private static async setPageDescription(webUrl: string, slug: string, description: string) {
    let pageData: any = await execScript(`localm365`, ArgumentsHelper.parse(`spo page get --webUrl "${webUrl}" --name "${slug}" --output json`));
    if (pageData && typeof pageData === "string") {
      pageData = JSON.parse(pageData);

      Logger.debug(pageData);
    }

    let listData: any = await execScript(`localm365`, ArgumentsHelper.parse(`spo list list --webUrl "${webUrl}" --output json`));
    if (listData && typeof listData === "string") {
      listData = JSON.parse(listData);
    }

    const pageList = (listData as ListData[]).find(l => l.Url.toLowerCase().includes("/sitepages"));

    if (pageData.ListItemAllFields && pageData.ListItemAllFields.Id && pageList) {
      await execScript(`localm365`, ArgumentsHelper.parse(`spo listitem set --listTitle "${pageList.Title}" --id ${pageData.ListItemAllFields.Id} --webUrl "${webUrl}" --Description "${description}" --systemUpdate`));
    }
  }

  /**
   * Publish the page
   * @param webUrl 
   * @param slug 
   */
  private static async publishPageIfNeeded(webUrl: string, slug: string) {
    const relativeUrl = FileHelpers.getRelUrl(webUrl, `sitepages/${slug}`);
    try {
      await execScript(`localm365`, ArgumentsHelper.parse(`spo file checkin --webUrl "${webUrl}" --fileUrl "${relativeUrl}"`));
    } catch (e) {
      // Might be that the file doesn't need to be checked in
    }
    await execScript(`localm365`, ArgumentsHelper.parse(`spo page set --name "${slug}" --webUrl "${webUrl}" --publish`));
  }
}
